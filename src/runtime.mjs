import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { appendAudit, recoverAuditLock, runDir, stateRoot } from './audit.mjs';
import { executeAction } from './actions.mjs';
import { applyStatePatch, createState, validateState } from './state.mjs';
import { controllerPrompt, controllerSchemaPath, runFreshController } from './controller.mjs';
import { sha256 } from './util.mjs';
import { assertFrozen, pinmindAdapter } from './pinmind.mjs';
import { doctorPinmindCheckpoint } from './checkpoint.mjs';

export const statePath = workspace => path.join(runDir(workspace), 'state.json');
export const pendingPath = workspace => path.join(stateRoot(), `${sha256(path.resolve(workspace)).slice(0, 24)}.pending-commit.json`);
export const quarantinePath = workspace => path.join(runDir(workspace), 'quarantine.json');
export const operationPath = (workspace, runId) => path.join(runDir(workspace), `${runId}.operations.jsonl`);
const workspaceLockPath = workspace => path.join(runDir(workspace), 'workspace.lock');
const quarantineResolutionPath = incident => incident.replace(/\.json$/, '.resolved.json');

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export async function acquireWorkspaceLock(workspace) {
  const file = workspaceLockPath(workspace); await mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  try {
    const handle = await open(file, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() })); await handle.close();
    return { file, token };
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`workspace is busy: ${path.resolve(workspace)}`);
    throw error;
  }
}

function deadLocalOwner(owner) {
  if (!owner || typeof owner !== 'object' || typeof owner.token !== 'string' || !owner.token || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function recoverWorkspaceLock(workspace, confirm) {
  const file = workspaceLockPath(workspace); let raw;
  try { raw = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let owner; try { owner = JSON.parse(raw); } catch { throw new Error('workspace lock is not safely recoverable'); }
  if (!confirm) return false;
  if (!deadLocalOwner(owner)) throw new Error('workspace lock is not safely recoverable');
  const current = await readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (current === null) return false;
  if (current !== raw) throw new Error('workspace lock ownership changed during recovery');
  await unlink(file);
  return true;
}

export async function releaseWorkspaceLock(lock) {
  if (!lock) return;
  try {
    const owner = JSON.parse(await readFile(lock.file, 'utf8'));
    if (owner.token !== lock.token) throw new Error('workspace lock ownership changed');
    await unlink(lock.file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function loadState(workspace) { const state = JSON.parse(await readFile(statePath(workspace), 'utf8')); return validateState(state); }
export async function saveState(workspace, state) { validateState(state); const file = statePath(workspace); await mkdir(path.dirname(file), { recursive: true }); await atomicWrite(file, state); }

async function writeImmutable(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); }
  finally { await handle.close(); }
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function acknowledgeQuarantine(workspace, incidentFile, incident) {
  const resolved = quarantineResolutionPath(incidentFile);
  try { await writeImmutable(resolved, { incidentSha256: sha256(incident), resolvedAt: new Date().toISOString() }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await appendAudit(workspace, 'quarantine_acknowledged', { action: incident.action });
  return resolved;
}

async function quarantineRecord(workspace, record, event) {
  const incident = { ...record, quarantinedAt: new Date().toISOString(), immutable: true };
  let file = quarantinePath(workspace);
  if (await readJson(file)) file = path.join(runDir(workspace), `quarantine.${sha256({ runId: record.runId, operationId: record.operationId, patchSha256: record.patchSha256, at: incident.quarantinedAt }).slice(0, 16)}.json`);
  await writeImmutable(file, incident);
  await appendAudit(workspace, event, { action: record.action, operationId: record.operationId });
  return file;
}

async function unresolvedQuarantines(workspace) {
  let names;
  try { names = await readdir(runDir(workspace)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const incidents = [];
  for (const name of names.filter(name => /^quarantine(?:\.[a-f0-9]{16})?\.json$/.test(name))) {
    const file = path.join(runDir(workspace), name); const incident = await readJson(file);
    if (incident && !await readJson(quarantineResolutionPath(file))) incidents.push({ file, incident });
  }
  return incidents;
}

export async function recover(workspace, confirm = false) {
  let lock;
  try { lock = await acquireWorkspaceLock(workspace); }
  catch (error) {
    if (!String(error.message).startsWith('workspace is busy:')) throw error;
    if (!confirm) return { recovered: false, lock: true, message: 'A workspace lock exists. Inspect it, then run recover --confirm only if its local owner is no longer running.' };
    await recoverWorkspaceLock(workspace, true);
    lock = await acquireWorkspaceLock(workspace);
  }
  try {
    if (confirm) await recoverAuditLock(workspace, true);
    const pending = pendingPath(workspace); const pendingRecord = await readJson(pending);
    if (pendingRecord) {
      if (!confirm) return { recovered: false, pending: true, action: pendingRecord.action, message: 'Inspect the working tree, then run recover --confirm. The action will not be repeated.' };
      const quarantined = await quarantineRecord(workspace, pendingRecord, 'recovered_to_quarantine');
      await unlink(pending);
      return { recovered: true, quarantined };
    }
    const [quarantine] = await unresolvedQuarantines(workspace);
    if (!quarantine) return { recovered: false, pending: false };
    if (!confirm) return { recovered: false, quarantined: true, action: quarantine.incident.action, message: 'A prior action is quarantined. Inspect the working tree, then run recover --confirm to acknowledge it.' };
    await acknowledgeQuarantine(workspace, quarantine.file, quarantine.incident);
    return { recovered: true, quarantined: quarantine.file, resolved: true };
  } finally { await releaseWorkspaceLock(lock); }
}

async function quarantinePending(workspace) {
  const pending = pendingPath(workspace); const record = await readJson(pending);
  if (!record) return false;
  const quarantine = await quarantineRecord(workspace, record, 'pending_quarantined');
  await unlink(pending);
  return quarantine;
}

async function appendOperation(workspace, state, operation) {
  const file = operationPath(workspace, state.runId); await mkdir(path.dirname(file), { recursive: true });
  const record = { at: new Date().toISOString(), runId: state.runId, revision: state.revision, ...operation };
  await writeFile(file, `${JSON.stringify(record)}\n`, { flag: 'a', mode: 0o600 });
  return record;
}

async function uncommittedOperation(workspace, state) {
  const file = operationPath(workspace, state.runId); let lines;
  try { lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const last = new Map();
  for (const line of lines) { const record = JSON.parse(line); if (record.operationId) last.set(record.operationId, record); }
  for (const record of last.values()) if (['planned', 'executed'].includes(record.status)) return record;
  return null;
}

async function hasFailedMutatingAction(workspace, state, action) {
  const file = operationPath(workspace, state.runId); let lines;
  try { lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const actionSha256 = sha256(action);
  return lines.some(line => { const record = JSON.parse(line); return record.status === 'failed' && record.actionSha256 === actionSha256; });
}

function isMutating(action) { return action.type === 'apply_patch'; }
function isVerificationAction(action, result) {
  if (!['read_file', 'search', 'git_diff', 'snapshot', 'worker'].includes(action.type)) return false;
  return !Object.hasOwn(result, 'code') || result.code === 0;
}
function isPostChangeVerification(action, result) {
  return ['git_diff', 'snapshot', 'worker'].includes(action.type) && isVerificationAction(action, result);
}
function receiptFor(state, action, result, started, response, status = 'ok') {
  const promptChars = JSON.stringify({ state, result }).length;
  return { revision: state.revision, action: action.type, status, at: new Date().toISOString(), durationMs: Date.now() - started,
    actionSha256: sha256(action), observationSha256: sha256(result), tokenMetrics: response._tokenMetrics || { promptChars, estimatedInputTokens: Math.ceil(promptChars / 4), outputTokens: null } };
}

function repeatsReadOnlyWithoutProgress(receipts, receipt) {
  if (!['read_file', 'search', 'git_diff', 'snapshot'].includes(receipt.action)) return false;
  const sinceMutation = receipts.slice().reverse().findIndex(item => item.action === 'apply_patch');
  const recent = sinceMutation < 0 ? receipts : receipts.slice(receipts.length - sinceMutation);
  return recent.filter(item => item.status === 'ok' && item.actionSha256 === receipt.actionSha256 && item.observationSha256 === receipt.observationSha256).length >= 2;
}

async function pauseFailedAction({ workspace, state, action, result, started, response, operation }) {
  if (operation) await appendOperation(workspace, state, { operationId: operation.operationId, status: 'failed', action: { type: action.type }, actionSha256: operation.actionSha256, resultSha256: sha256(result) });
  if (action.type === 'apply_patch') await unlink(pendingPath(workspace)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const receipt = receiptFor(state, action, result, started, response, 'failed');
  state.receipts = [...state.receipts.slice(-99), receipt]; state.lifecycle = 'paused';
  await saveState(workspace, state); await appendAudit(workspace, 'action_failed', { runId: state.runId, revision: state.revision, action: action.type, resultSha256: receipt.observationSha256 });
  return receipt;
}

export async function doctor({ workspace = process.cwd(), controller, pinmindPath, pinmindRun } = {}) {
  if (!controller) return doctorPinmindCheckpoint({ workspace, runId: pinmindRun });
  if (!['codex', 'pinmind'].includes(controller)) throw new Error('invalid controller');
  const checks = [{ name: 'workspace', ok: true, value: path.resolve(workspace) }];
  try { const probe = await import('./controller.mjs').then(({ spawnCapture }) => spawnCapture('codex', ['--version'], workspace)); checks.push({ name: 'codex', ok: probe.code === 0, code: probe.code, stderrSha256: probe.stderr ? sha256(probe.stderr) : null }); }
  catch { checks.push({ name: 'codex', ok: false, detail: 'probe failed' }); }
  if (controller === 'pinmind') try { const route = await pinmindAdapter({ pinmindPath, task: 'diagnostic' }); checks.push({ name: 'pinmind', ok: true, route: route.route }); } catch { checks.push({ name: 'pinmind', ok: false, detail: 'route unavailable' }); }
  return { ok: checks.every(check => check.ok), mode: 'controller-diagnostic', checks };
}

export async function run(options) {
  const { workspace = process.cwd(), task, resume = false, mode = 'strict', sandbox = 'read-only', controller = 'codex', pinmindPath, maxSteps = 12, codex = 'codex', root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..') } = options;
  if ((!resume && (!task || typeof task !== 'string')) || (task !== undefined && typeof task !== 'string')) throw new Error('--task or --task-file is required');
  if (!['strict', 'hybrid'].includes(mode) || !['read-only', 'workspace-write'].includes(sandbox)) throw new Error('invalid mode or sandbox');
  if (!['codex', 'pinmind'].includes(controller)) throw new Error('invalid controller');
  const lock = await acquireWorkspaceLock(workspace);
  try {
    const quarantined = await quarantinePending(workspace);
    if (quarantined) throw new Error(`A pending action was quarantined at ${quarantined}. Inspect the working tree, then explicitly run recover --confirm.`);
    let policy; let frozen; let state;
    if (resume) {
      state = await loadState(workspace);
      if (!['paused', 'awaiting_user'].includes(state.lifecycle)) throw new Error(`run ${state.runId} is not resumable`);
      const unfinished = await uncommittedOperation(workspace, state);
      if (unfinished) {
        const incident = await quarantineRecord(workspace, unfinished, 'operation_quarantined');
        throw new Error(`An uncommitted operation was quarantined at ${incident}. Inspect it, then explicitly run recover --confirm.`);
      }
      state.lifecycle = 'active'; await saveState(workspace, state);
      policy = { controller, localMutation: state.authority.localMutation, externalEffects: false }; frozen = state.frozen;
      await appendAudit(workspace, 'run_resumed', { runId: state.runId });
    } else {
      const existing = await readJson(statePath(workspace));
      if (existing && ['active', 'paused', 'awaiting_user'].includes(existing.lifecycle)) throw new Error(`run ${existing.runId} is unfinished; use --resume`);
      policy = { controller, localMutation: sandbox === 'workspace-write', externalEffects: false }; frozen = [];
      if (controller === 'pinmind') { const routed = await pinmindAdapter({ pinmindPath, task }); policy = { ...policy, ...routed }; frozen = routed.frozen; }
      if (policy.needsHumanConfirmation) policy.localMutation = false;
      state = createState({ objective: task, authority: { localMutation: Boolean(policy.localMutation), externalEffects: false }, frozen });
      await saveState(workspace, state); await appendAudit(workspace, 'run_started', { runId: state.runId, mode, controller, stateSha256: sha256(state) });
    }
    let observation = { type: resume ? 'resume' : 'start', task: resume ? 'Run resumed' : 'Task accepted' };
    for (let step = 0; step < maxSteps; step++) {
      await assertFrozen(frozen);
      const started = Date.now();
      const response = await runFreshController({ codex, workspace, schemaPath: controllerSchemaPath(root), prompt: controllerPrompt({ state, observation, policy, mode }) });
      state = applyStatePatch(state, response); const action = response.action;
      await assertFrozen(frozen);
      if (action.type === 'apply_patch' && state.phase === 'inspect') {
        await pauseFailedAction({ workspace, state, action, result: { error: 'inspection is required before apply_patch' }, started, response });
        throw new Error('inspection is required before apply_patch');
      }
      if (action.type === 'finish' && state.phase === 'change') {
        await pauseFailedAction({ workspace, state, action, result: { error: 'verification is required after apply_patch before finish' }, started, response });
        throw new Error('verification is required after apply_patch before finish');
      }
      if (isMutating(action) && await hasFailedMutatingAction(workspace, state, action)) {
        await pauseFailedAction({ workspace, state, action, result: { error: 'repeated failed mutating action' }, started, response });
        throw new Error('repeated failed mutating action');
      }
      let operation;
      if (isMutating(action)) operation = await appendOperation(workspace, state, { operationId: randomUUID(), status: 'planned', action: { type: action.type }, actionSha256: sha256(action) });
      let result;
      try { result = await executeAction({ action, workspace, mode, authority: state.authority, codex }); }
      catch (error) {
        if (operation) { await pauseFailedAction({ workspace, state, action, result: { error: error.message }, started, response, operation }); }
        throw error;
      }
      const failed = action.type === 'apply_patch' && !result.applied;
      if (failed) {
        await pauseFailedAction({ workspace, state, action, result, started, response, operation });
        throw new Error(`${action.type} failed; run paused`);
      }
      if (operation) await appendOperation(workspace, state, { operationId: operation.operationId, status: 'executed', action: { type: action.type }, resultSha256: sha256(result) });
      if (action.type === 'apply_patch') await unlink(pendingPath(workspace)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (action.type === 'apply_patch') state.phase = 'change';
      else if (state.phase === 'inspect' && isVerificationAction(action, result)) state.phase = 'ready_to_change';
      else if (state.phase === 'change' && isPostChangeVerification(action, result)) state.phase = 'verify';
      const receipt = receiptFor(state, action, result, started, response);
      state.receipts = [...state.receipts.slice(-99), receipt];
      if (repeatsReadOnlyWithoutProgress(state.receipts.slice(0, -1), receipt)) {
        state.lifecycle = 'paused';
        state.blockers = [...state.blockers.slice(-49), 'No progress: the same read-only action returned the same result three times.'];
        await saveState(workspace, state);
        await appendAudit(workspace, 'paused', { runId: state.runId, reason: 'no_progress', action: action.type });
        return { state, observation: result, steps: step + 1, reason: 'no_progress' };
      }
      if (action.type === 'finish') { state.lifecycle = 'finished'; state.finalResult = result.result; }
      if (action.type === 'ask') state.lifecycle = 'awaiting_user';
      await saveState(workspace, state);
      if (operation) await appendOperation(workspace, state, { operationId: operation.operationId, status: 'committed', action: { type: action.type }, resultSha256: receipt.observationSha256 });
      await appendAudit(workspace, 'step', { runId: state.runId, revision: state.revision, action: action.type, resultSha256: receipt.observationSha256, durationMs: receipt.durationMs });
      observation = result;
      if (state.lifecycle !== 'active') return { state, observation, steps: step + 1 };
    }
    state.lifecycle = 'paused'; await saveState(workspace, state); await appendAudit(workspace, 'paused', { runId: state.runId, reason: 'max_steps' });
    return { state, observation, steps: maxSteps };
  } finally { await releaseWorkspaceLock(lock); }
}
