import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { executeAction, validateAction } from '../src/actions.mjs';
import { appendAudit, auditPath, verifyAudit } from '../src/audit.mjs';
import { controllerResponseFromJsonl, rejectControllerJsonl, tokenMetricsFromJsonl } from '../src/controller.mjs';
import { pendingPath, quarantinePath, recover, run } from '../src/runtime.mjs';
import { applyStatePatch, createState, mergePatch, validateState } from '../src/state.mjs';
import { sha256, VERSION, workspacePath } from '../src/util.mjs';
import { parseArgs } from '../bin/skillstate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = path.join(here, 'fixtures', 'fake-codex.mjs');
const cleanups = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillstate-test-'));
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'state');
  await mkdir(workspace); process.env.XDG_STATE_HOME = state; cleanups.push(root);
  return { root, workspace, state };
}
test.after(async () => { delete process.env.XDG_STATE_HOME; delete process.env.SKILLSTATE_FAKE_LOG; delete process.env.SKILLSTATE_FAKE_MODE; await Promise.all(cleanups.map(item => rm(item, { recursive: true, force: true }))); });

test('01 exposes the experimental version', () => assert.equal(VERSION, '0.1.0-experimental'));

test('02 parses CLI flags', () => assert.deepEqual(parseArgs(['run', '--mode', 'strict', '--confirm']), { command: 'run', options: { mode: 'strict', confirm: true } }));

test('03 creates a bounded initial state', () => {
  const state = createState({ objective: 'inspect' });
  assert.equal(state.revision, 0); assert.equal(state.lifecycle, 'active'); assert.deepEqual(state.facts, []);
});

test('04 implements JSON Merge Patch array replacement and null deletion', () => {
  assert.deepEqual(mergePatch({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { c: null } }), { a: [3], b: { d: 2 } });
});

test('05 applies a SHA-bound state patch and increments revision', () => {
  const state = createState({ objective: 'inspect' });
  const next = applyStatePatch(state, { baseStateSha256: sha256(state), state_patch: { facts: ['ok'] }, action: { type: 'finish', result: 'ok' } });
  assert.equal(next.revision, 1); assert.deepEqual(next.facts, ['ok']);
});

test('06 rejects a stale state SHA', () => {
  const state = createState({ objective: 'inspect' });
  assert.throws(() => applyStatePatch(state, { baseStateSha256: '0'.repeat(64), state_patch: { facts: [] }, action: { type: 'finish', result: 'x' } }), /does not match/);
});

test('07 rejects protected and unknown state fields', () => {
  const state = createState({ objective: 'inspect' }); const baseStateSha256 = sha256(state);
  assert.throws(() => applyStatePatch(state, { baseStateSha256, state_patch: { objective: 'replace' } }), /cannot add state field|protected/);
  assert.throws(() => applyStatePatch(state, { baseStateSha256, state_patch: { history: [] } }), /cannot add state field/);
});

test('08 rejects oversized state sections and payloads', () => {
  const state = createState({ objective: 'inspect' });
  assert.throws(() => validateState({ ...state, facts: Array(51).fill('x') }), /at most 50/);
  assert.throws(() => validateState({ ...state, facts: ['x'.repeat(140000)] }), /bounded strings|128 KiB/);
});

test('09 rejects absolute paths and traversal', async () => {
  const { workspace } = await fixture();
  await assert.rejects(workspacePath(workspace, '/etc/passwd'), /relative path/);
  await assert.rejects(workspacePath(workspace, '../outside'), /escapes workspace/);
});

test('10 rejects a symlink target', async () => {
  const { root, workspace } = await fixture(); await writeFile(path.join(root, 'outside'), 'secret'); await symlink(path.join(root, 'outside'), path.join(workspace, 'link'));
  await assert.rejects(workspacePath(workspace, 'link'), /symlink/);
});

test('11 executes a bounded local read action', async () => {
  const { workspace } = await fixture(); await writeFile(path.join(workspace, 'a.txt'), 'abcdef');
  const result = await executeAction({ action: { type: 'read_file', path: 'a.txt', maxBytes: 3 }, workspace, mode: 'strict', authority: { localMutation: false } });
  assert.equal(result.content, 'abc'); assert.equal(result.truncated, true);
});

test('12 rejects worker actions in strict mode', () => assert.throws(() => validateAction({ type: 'worker', task: 'inspect' }, { mode: 'strict', authority: { localMutation: true } }), /hybrid/));

test('13 rejects mutation without authority', () => assert.throws(() => validateAction({ type: 'apply_patch', patch: 'diff' }, { mode: 'hybrid', authority: { localMutation: false } }), /not authorized/));

test('14 rejects every external-effect worker class', () => {
  for (const word of ['push', 'PR', 'deploy', 'publish', 'message', 'payment', 'production', 'credential']) assert.throws(() => validateAction({ type: 'worker', task: `${word} now` }, { mode: 'hybrid', authority: { localMutation: true } }), /external-effect/);
});

test('15 rejects patches aimed at Git metadata', async () => {
  const { workspace } = await fixture();
  await assert.rejects(executeAction({ action: { type: 'apply_patch', patch: '--- a/.git/config\n+++ b/.git/config\n@@ -0,0 +1 @@\n+x\n' }, workspace, mode: 'hybrid', authority: { localMutation: true } }), /unsafe path/);
});

test('16 rejects controller tool use from JSONL', () => {
  const jsonl = JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } });
  assert.throws(() => rejectControllerJsonl(jsonl), /forbidden tool/);
});

test('17 parses controller output and real token usage fields', () => {
  const envelope = { baseStateSha256: 'a'.repeat(64), state_patch: { facts: [] }, action: { type: 'finish', result: 'ok' } };
  const jsonl = `${JSON.stringify({ item: { type: 'agent_message', text: JSON.stringify(envelope) } })}\n${JSON.stringify({ usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 } })}`;
  assert.deepEqual(controllerResponseFromJsonl(jsonl), envelope); assert.deepEqual(tokenMetricsFromJsonl(jsonl), { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4 });
});

test('18 verifies an intact audit chain and head', async () => {
  const { workspace } = await fixture(); await appendAudit(workspace, 'one'); await appendAudit(workspace, 'two');
  assert.deepEqual((await verifyAudit(workspace)).ok, true);
});

test('19 detects a one-byte audit edit', async () => {
  const { workspace } = await fixture(); await appendAudit(workspace, 'one'); const file = auditPath(workspace); const content = await readFile(file, 'utf8'); await writeFile(file, content.replace('one', 'eno'));
  assert.equal((await verifyAudit(workspace)).ok, false);
});

test('20 detects audit truncation', async () => {
  const { workspace } = await fixture(); await appendAudit(workspace, 'one'); await appendAudit(workspace, 'two'); const file = auditPath(workspace); const lines = (await readFile(file, 'utf8')).trim().split('\n'); await writeFile(file, `${lines[0]}\n`);
  assert.equal((await verifyAudit(workspace)).error, 'audit head mismatch');
});

test('21 requires explicit recovery and never retries a pending action', async () => {
  const { workspace } = await fixture(); const pending = pendingPath(workspace); await mkdir(path.dirname(pending), { recursive: true }); await writeFile(pending, JSON.stringify({ action: { type: 'apply_patch' }, patchSha256: 'a'.repeat(64) }));
  assert.equal((await recover(workspace, false)).pending, true); assert.equal((await recover(workspace, true)).recovered, true);
  await assert.rejects(lstat(pending), /ENOENT/); assert.equal((await lstat(quarantinePath(workspace))).isFile(), true);
});

test('22 runs two fresh strict controllers without forwarding private output', async () => {
  const { root, workspace } = await fixture(); await writeFile(path.join(workspace, 'example.txt'), 'hello\n'); const log = path.join(root, 'prompts.jsonl'); await chmod(fakeCodex, 0o755); process.env.SKILLSTATE_FAKE_LOG = log;
  const result = await run({ workspace, task: 'Inspect example.txt without changing anything.', mode: 'strict', sandbox: 'read-only', controller: 'codex', maxSteps: 2, codex: fakeCodex });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(result.state.lifecycle, 'finished'); assert.equal(calls.length, 2); assert.notEqual(calls[0].pid, calls[1].pid); assert.equal(calls[1].prompt.includes('DO_NOT_FORWARD_42'), false); assert.deepEqual(result.state.receipts[0].tokenMetrics, { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30 });
});
