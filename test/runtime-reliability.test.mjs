import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendAudit, auditHeadPath, recoverAuditLock, runDir, verifyAudit } from '../src/audit.mjs';
import { acquireWorkspaceLock, loadState, operationPath, recover, releaseWorkspaceLock, run, saveState } from '../src/runtime.mjs';
import { createState } from '../src/state.mjs';
import { pinmindAdapter } from '../src/pinmind.mjs';

const cleanups = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillstate-reliability-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  process.env.XDG_STATE_HOME = path.join(root, 'state');
  cleanups.push(root);
  return { root, workspace };
}
test.after(async () => {
  delete process.env.XDG_STATE_HOME;
  await Promise.all(cleanups.map(root => rm(root, { recursive: true, force: true })));
});

test('writer lock rejects a second owner and releases cleanly', async () => {
  const { workspace } = await fixture();
  const first = await acquireWorkspaceLock(workspace);
  await assert.rejects(acquireWorkspaceLock(workspace), /workspace is busy/);
  await releaseWorkspaceLock(first);
  await releaseWorkspaceLock(await acquireWorkspaceLock(workspace));
});

test('Pinmind adapter routes in-process without a nested Node subprocess', async () => {
  const { workspace } = await fixture();
  const pinmind = path.join(workspace, 'pinmind');
  await mkdir(path.join(pinmind, 'scripts', 'lib'), { recursive: true });
  await mkdir(path.join(pinmind, 'references'));
  await writeFile(path.join(pinmind, 'SKILL.md'), 'test skill');
  await writeFile(path.join(pinmind, 'scripts', 'pinmind.mjs'), 'test cli');
  await writeFile(path.join(pinmind, 'scripts', 'lib', 'route.mjs'), `export const routeTask = () => ({ route: 'audit', clarity: 'clear', executionSpan: 'local', risk: 'low', needsHumanConfirmation: false });`);
  await writeFile(path.join(pinmind, 'references', 'route.md'), 'route');
  const result = await pinmindAdapter({ pinmindPath: pinmind, task: 'audit' });
  assert.equal(result.route, 'audit');
  assert.equal(result.frozen.length, 4);
});

test('recovery only removes a confirmed stale workspace lock', async () => {
  const { workspace } = await fixture();
  const lock = path.join(runDir(workspace), 'workspace.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ token: 'stale-token', pid: 99999999, hostname: os.hostname(), at: new Date().toISOString() }));
  const preview = await recover(workspace);
  assert.equal(preview.recovered, false); assert.equal(preview.lock, true);
  assert.match(await readFile(lock, 'utf8'), /stale-token/);
  const confirmed = await recover(workspace, true);
  assert.equal(confirmed.recovered, false);
  await assert.rejects(readFile(lock));
});

test('recovery never reclaims a live workspace lock', async () => {
  const { workspace } = await fixture();
  const lock = await acquireWorkspaceLock(workspace);
  await assert.rejects(recover(workspace, true), /not safely recoverable/);
  await releaseWorkspaceLock(lock);
});

test('audit lock recovery needs confirmation and a dead local owner', async () => {
  const { workspace } = await fixture();
  const lock = path.join(runDir(workspace), 'audit.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ token: 'stale-token', pid: 99999999, hostname: os.hostname(), at: new Date().toISOString() }));
  assert.equal(await recoverAuditLock(workspace, false), false);
  await assert.equal(await recoverAuditLock(workspace, true), true);
  await appendAudit(workspace, 'after_recovery');
  assert.equal((await verifyAudit(workspace)).ok, true);
});

test('atomic state writes stay valid under concurrent saves', async () => {
  const { workspace } = await fixture();
  const state = createState({ objective: 'test' });
  await Promise.all(Array.from({ length: 20 }, (_, revision) => saveState(workspace, { ...state, revision })));
  assert.ok((await loadState(workspace)).revision >= 0);
});

test('audit repairs a missing head on the next append', async () => {
  const { workspace } = await fixture();
  await appendAudit(workspace, 'one');
  await unlink(auditHeadPath(workspace));
  await appendAudit(workspace, 'two');
  assert.equal((await verifyAudit(workspace)).ok, true);
});

test('apply_patch is blocked until a successful inspection action', async () => {
  const { workspace } = await fixture();
  const controller = path.join(workspace, 'patch-first.mjs');
  await writeFile(controller, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'; const p=process.argv.at(-1); const sha=p.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1]; writeFileSync(1, JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({baseStateSha256:sha,state_patch:{},action:{type:'apply_patch',patch:'not a patch'}})}})+'\\n');`);
  await chmod(controller, 0o755);
  await assert.rejects(run({ workspace, task: 'change', mode: 'hybrid', sandbox: 'workspace-write', maxSteps: 1, codex: controller }), /inspection is required/);
  const state = await loadState(workspace);
  assert.equal(state.phase, 'inspect'); assert.equal(state.lifecycle, 'paused');
});

test('failed apply_patch is journaled, recorded, and pauses immediately', async () => {
  const { workspace } = await fixture();
  await writeFile(path.join(workspace, 'example.txt'), 'before\n');
  const controller = path.join(workspace, 'fake-controller.mjs');
  await writeFile(controller, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'; const p=process.argv.at(-1); const sha=p.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1]; const action=p.includes('\\"phase\\":\\"inspect\\"')?{type:'read_file',path:'example.txt'}:{type:'apply_patch',patch:'not a patch'}; writeFileSync(1, JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({baseStateSha256:sha,state_patch:{facts:['attempted']},action})}})+'\\n');`);
  await chmod(controller, 0o755);
  await assert.rejects(run({ workspace, task: 'change', mode: 'hybrid', sandbox: 'workspace-write', maxSteps: 2, codex: controller }), /patch|apply/);
  const state = await loadState(workspace);
  assert.equal(state.lifecycle, 'paused');
  assert.equal(state.receipts.at(-1).status, 'failed');
  const journal = await readFile(operationPath(workspace, state.runId), 'utf8');
  assert.match(journal, /"planned"/); assert.match(journal, /"failed"/);
  await assert.rejects(run({ workspace, resume: true, mode: 'hybrid', sandbox: 'workspace-write', maxSteps: 1, codex: controller }), /repeated failed mutating action/);
});

test('a successful patch requires a successful read-only verification before finish', async () => {
  const { workspace } = await fixture();
  await writeFile(path.join(workspace, 'example.txt'), 'before\n');
  const controller = path.join(workspace, 'phase-controller.mjs');
  await writeFile(controller, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv.at(-1);
const sha = prompt.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1];
let action;
if (prompt.includes('\\"phase\\":\\"inspect\\"')) action = { type: 'read_file', path: 'example.txt', maxBytes: 64 };
else if (prompt.includes('\\"phase\\":\\"ready_to_change\\"')) action = { type: 'apply_patch', patch: '--- a/example.txt\\n+++ b/example.txt\\n@@ -1 +1 @@\\n-before\\n+after\\n' };
else action = { type: 'finish', result: 'done' };
writeFileSync(1, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ baseStateSha256: sha, state_patch: {}, action }) } }) + '\\n');`);
  await chmod(controller, 0o755);
  await assert.rejects(run({ workspace, task: 'change', mode: 'hybrid', sandbox: 'workspace-write', maxSteps: 3, codex: controller }), /verification is required/);
  const state = await loadState(workspace);
  assert.equal(state.phase, 'change'); assert.equal(state.lifecycle, 'paused');
});

test('a read-only action after a patch permits finish', async () => {
  const { workspace } = await fixture();
  await writeFile(path.join(workspace, 'example.txt'), 'before\n');
  const controller = path.join(workspace, 'verified-phase-controller.mjs');
  await writeFile(controller, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv.at(-1);
const sha = prompt.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1];
let action;
if (prompt.includes('\\"phase\\":\\"inspect\\"')) action = { type: 'read_file', path: 'example.txt', maxBytes: 64 };
else if (prompt.includes('\\"phase\\":\\"ready_to_change\\"')) action = { type: 'apply_patch', patch: '--- a/example.txt\\n+++ b/example.txt\\n@@ -1 +1 @@\\n-before\\n+after\\n' };
else if (prompt.includes('\\"phase\\":\\"change\\"')) action = { type: 'worker', task: 'Verify the local change without modifying files.' };
else action = { type: 'finish', result: 'done' };
writeFileSync(1, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ baseStateSha256: sha, state_patch: {}, action }) } }) + '\\n');`);
  await chmod(controller, 0o755);
  const result = await run({ workspace, task: 'change', mode: 'hybrid', sandbox: 'workspace-write', maxSteps: 4, codex: controller });
  assert.equal(result.state.phase, 'verify'); assert.equal(result.state.lifecycle, 'finished');
});

test('repeated identical reads pause before the step limit', async () => {
  const { workspace } = await fixture();
  await writeFile(path.join(workspace, 'a.txt'), 'same a\n');
  await writeFile(path.join(workspace, 'b.txt'), 'same b\n');
  const controller = path.join(workspace, 'loop-controller.mjs');
  await writeFile(controller, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const prompt = process.argv.at(-1);
const sha = prompt.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1];
const revision = Number(prompt.match(/\\"revision\\":(\\d+)/)?.[1] ?? 0);
const action = { type: 'read_file', path: revision % 2 ? 'b.txt' : 'a.txt', maxBytes: 64 };
writeFileSync(1, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ baseStateSha256: sha, state_patch: {}, action }) } }) + '\\n');`);
  await chmod(controller, 0o755);
  const result = await run({ workspace, task: 'inspect', mode: 'strict', sandbox: 'read-only', maxSteps: 10, codex: controller });
  assert.equal(result.reason, 'no_progress');
  assert.equal(result.steps, 5);
  assert.equal(result.state.lifecycle, 'paused');
  assert.match(result.state.blockers.at(-1), /No progress/);
});

test('resume continues an awaiting run instead of replacing its run id', async () => {
  const { workspace } = await fixture();
  const state = createState({ objective: 'continue' }); state.lifecycle = 'awaiting_user';
  await saveState(workspace, state);
  const controller = path.join(workspace, 'finish.mjs');
  await writeFile(controller, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs'; const p=process.argv.at(-1); const sha=p.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1]; writeFileSync(1, JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({baseStateSha256:sha,state_patch:{},action:{type:'finish',result:'done'}})}})+'\\n');`);
  await chmod(controller, 0o755);
  const result = await run({ workspace, resume: true, mode: 'strict', sandbox: 'read-only', maxSteps: 1, codex: controller });
  assert.equal(result.state.runId, state.runId); assert.equal(result.state.lifecycle, 'finished');
});

test('new state uses the 0.2 protocol with protected workflow metadata', () => {
  const state = createState({ objective: 'test', authority: { localMutation: true, externalEffects: false } });
  assert.equal(state.protocol, 'codex-skillstate/0.2');
  assert.equal(state.phase, 'inspect');
  assert.deepEqual(state.constraints, ['external effects disabled', 'local mutation allowed']);
});

test('quarantine acknowledgement preserves the original incident', async () => {
  const { workspace } = await fixture();
  const pending = path.join(process.env.XDG_STATE_HOME, 'codex-skillstate', `${(await import('../src/util.mjs')).sha256(path.resolve(workspace)).slice(0, 24)}.pending-commit.json`);
  await mkdir(path.dirname(pending), { recursive: true });
  await writeFile(pending, JSON.stringify({ action: { type: 'apply_patch' }, patchSha256: 'a'.repeat(64) }));
  const first = await recover(workspace, true);
  const original = await readFile(first.quarantined, 'utf8');
  await recover(workspace, true);
  assert.equal(await readFile(first.quarantined, 'utf8'), original);
});
