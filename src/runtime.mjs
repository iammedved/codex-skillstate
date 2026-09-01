import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { appendAudit, runDir, stateRoot } from './audit.mjs';
import { executeAction } from './actions.mjs';
import { applyStatePatch, createState, validateState } from './state.mjs';
import { controllerPrompt, controllerSchemaPath, runFreshController } from './controller.mjs';
import { sha256 } from './util.mjs';
import { assertFrozen, pinmindAdapter } from './pinmind.mjs';

export const statePath = workspace => path.join(runDir(workspace), 'state.json');
export const pendingPath = workspace => path.join(stateRoot(), `${sha256(path.resolve(workspace)).slice(0, 24)}.pending-commit.json`);
export const quarantinePath = workspace => path.join(runDir(workspace), 'quarantine.json');

export async function loadState(workspace) { const state = JSON.parse(await readFile(statePath(workspace), 'utf8')); return validateState(state); }
export async function saveState(workspace, state) { const file = statePath(workspace); await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.tmp`; await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); await rename(tmp, file); }

export async function recover(workspace, confirm = false) {
  const pending = pendingPath(workspace); let record;
  try { record = JSON.parse(await readFile(pending, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { record = JSON.parse(await readFile(quarantinePath(workspace), 'utf8')); }
    catch (quarantineError) { if (quarantineError.code === 'ENOENT') return { recovered: false, pending: false }; throw quarantineError; }
    if (!confirm) return { recovered: false, quarantined: true, action: record.action, message: 'A prior action is quarantined. Inspect the working tree, then run recover --confirm to acknowledge it.' };
    record.recoveryConfirmedAt = new Date().toISOString(); await writeFile(quarantinePath(workspace), JSON.stringify(record, null, 2), { mode: 0o600 });
    await appendAudit(workspace, 'quarantine_acknowledged', { action: record.action }); return { recovered: true, quarantined: quarantinePath(workspace) };
  }
  if (!confirm) return { recovered: false, pending: true, action: record.action, message: 'Inspect the working tree, then run recover --confirm. The action will not be repeated.' };
  await mkdir(path.dirname(quarantinePath(workspace)), { recursive: true }); await writeFile(quarantinePath(workspace), JSON.stringify({ ...record, quarantinedAt: new Date().toISOString() }, null, 2), { mode: 0o600 }); await unlink(pending);
  await appendAudit(workspace, 'recovered_to_quarantine', { action: record.action, patchSha256: record.patchSha256 });
  return { recovered: true, quarantined: quarantinePath(workspace) };
}

async function quarantinePending(workspace) {
  const pending = pendingPath(workspace);
  try { await readFile(pending, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const quarantine = quarantinePath(workspace);
  await mkdir(path.dirname(quarantine), { recursive: true }); await rename(pending, quarantine);
  await appendAudit(workspace, 'pending_quarantined', { quarantine });
  return quarantine;
}

export async function doctor({ workspace = process.cwd(), controller = 'codex', pinmindPath } = {}) {
  const checks = [{ name: 'workspace', ok: true, value: path.resolve(workspace) }];
  try { const probe = await import('./controller.mjs').then(({ spawnCapture }) => spawnCapture('codex', ['--version'], workspace)); checks.push({ name: 'codex', ok: probe.code === 0, detail: probe.stderr.slice(-300) }); }
  catch (error) { checks.push({ name: 'codex', ok: false, detail: error.message }); }
  if (controller === 'pinmind') try { const route = await pinmindAdapter({ pinmindPath, task: 'diagnostic' }); checks.push({ name: 'pinmind', ok: true, route: route.route }); } catch (error) { checks.push({ name: 'pinmind', ok: false, detail: error.message }); }
  return { ok: checks.every(check => check.ok), checks };
}

export async function run(options) {
  const { workspace = process.cwd(), task, mode = 'strict', sandbox = 'read-only', controller = 'codex', pinmindPath, maxSteps = 12, codex = 'codex', root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..') } = options;
  if (!task || typeof task !== 'string') throw new Error('--task or --task-file is required');
  if (!['strict', 'hybrid'].includes(mode) || !['read-only', 'workspace-write'].includes(sandbox)) throw new Error('invalid mode or sandbox');
  if (!['codex', 'pinmind'].includes(controller)) throw new Error('invalid controller');
  const quarantined = await quarantinePending(workspace);
  if (quarantined) throw new Error(`A pending action was quarantined at ${quarantined}. Inspect the working tree, then explicitly run recover --confirm.`);
  let policy = { controller, localMutation: sandbox === 'workspace-write', externalEffects: false };
  let frozen = [];
  if (controller === 'pinmind') { const routed = await pinmindAdapter({ pinmindPath, task }); policy = { ...policy, ...routed }; frozen = routed.frozen; }
  if (policy.needsHumanConfirmation) policy.localMutation = false;
  let state = createState({ objective: task, authority: { localMutation: Boolean(policy.localMutation), externalEffects: false }, frozen });
  await saveState(workspace, state); await appendAudit(workspace, 'run_started', { runId: state.runId, mode, controller, stateSha256: sha256(state) });
  let observation = { type: 'start', task: 'Task accepted' };
  for (let step = 0; step < maxSteps; step++) {
    await assertFrozen(frozen);
    const started = Date.now();
    const response = await runFreshController({ codex, workspace, schemaPath: controllerSchemaPath(root), prompt: controllerPrompt({ state, observation, policy, mode }) });
    state = applyStatePatch(state, response);
    const action = response.action;
    await assertFrozen(frozen);
    const result = await executeAction({ action, workspace, mode, authority: state.authority, codex });
    if (action.type === 'apply_patch' && result.applied) await unlink(pendingPath(workspace)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const promptChars = JSON.stringify({ state, observation, policy }).length;
    const receipt = { revision: state.revision, action: action.type, at: new Date().toISOString(), durationMs: Date.now() - started, observationSha256: sha256(result), tokenMetrics: response._tokenMetrics || { promptChars, estimatedInputTokens: Math.ceil(promptChars / 4), outputTokens: null } };
    state.receipts = [...state.receipts.slice(-99), receipt];
    if (action.type === 'finish') { state.lifecycle = 'finished'; state.finalResult = result.result; }
    if (action.type === 'ask') state.lifecycle = 'awaiting_user';
    await saveState(workspace, state); await appendAudit(workspace, 'step', { runId: state.runId, revision: state.revision, action: action.type, resultSha256: receipt.observationSha256, durationMs: receipt.durationMs });
    observation = result;
    if (state.lifecycle !== 'active') return { state, observation, steps: step + 1 };
  }
  state.lifecycle = 'paused'; await saveState(workspace, state); await appendAudit(workspace, 'paused', { runId: state.runId, reason: 'max_steps' });
  return { state, observation, steps: maxSteps };
}
