import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkpointAuditPath, checkpointPath, checkpointPendingPath, checkpointPinmind, recoverPinmindCheckpoint, showPinmindCheckpoint, verifyPinmindCheckpoint } from '../src/checkpoint.mjs';
import { doctor } from '../src/runtime.mjs';
import { sha256, stableJson } from '../src/util.mjs';

const cleanups = [];

async function fixture(runId = 'run-one') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillstate-checkpoint-'));
  const workspace = path.join(root, 'workspace');
  const run = path.join(workspace, '.pinmind', 'runs', runId);
  await mkdir(run, { recursive: true });
  await writeFile(path.join(workspace, '.pinmind', 'active.json'), JSON.stringify({ runId }));
  await writeFile(path.join(run, 'state.json'), JSON.stringify({ runId, status: 'active', phase: 'execute', currentContractVersion: 1, updatedAt: '2026-09-01T00:00:00.000Z' }));
  cleanups.push(root);
  return { root, workspace, runId, run };
}

test.after(async () => {
  await Promise.all(cleanups.map(root => rm(root, { recursive: true, force: true })));
});

test('Pinmind checkpoint records bounded metadata and is idempotent', async () => {
  const { workspace, runId, run } = await fixture();
  const first = await checkpointPinmind(workspace, runId);
  assert.equal(first.origin, 'pinmind');
  assert.equal(first.phase, 'execute');
  assert.equal(first.currentContractVersion, 1);
  assert.equal(first.unchanged, false);
  const second = await checkpointPinmind(workspace, runId);
  assert.equal(second.unchanged, true);
  assert.equal((await readFile(checkpointAuditPath(workspace), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await verifyPinmindCheckpoint(workspace)).ok, true);
  await writeFile(path.join(run, 'state.json'), JSON.stringify({ runId, status: 'active', phase: 'verify', currentContractVersion: 1, updatedAt: '2026-09-01T00:01:00.000Z' }));
  assert.equal((await checkpointPinmind(workspace, runId)).phase, 'verify');
  assert.equal((await showPinmindCheckpoint(workspace)).phase, 'verify');
});

test('Pinmind checkpoint rejects unsafe, mismatched, and symlinked state', async () => {
  const { root, workspace, runId, run } = await fixture();
  await assert.rejects(checkpointPinmind(workspace, '../escape'), /safe run id/);
  await writeFile(path.join(run, 'state.json'), JSON.stringify({ runId: 'other', status: 'active', phase: 'execute', updatedAt: '2026-09-01T00:00:00.000Z' }));
  await assert.rejects(checkpointPinmind(workspace, runId), /valid Pinmind state/);
  const outside = path.join(root, 'outside.json');
  await writeFile(outside, JSON.stringify({ runId, status: 'active', phase: 'execute', updatedAt: '2026-09-01T00:00:00.000Z' }));
  await rm(path.join(run, 'state.json'));
  await symlink(outside, path.join(run, 'state.json'));
  await assert.rejects(checkpointPinmind(workspace, runId), /regular file|escapes/);
});

test('checkpoint verification distinguishes an absent pair from a valid current pair', async () => {
  const { workspace, runId } = await fixture();
  const missing = await verifyPinmindCheckpoint(workspace);
  assert.equal(missing.ok, false); assert.equal(missing.status, 'missing');
  await checkpointPinmind(workspace, runId);
  const current = await verifyPinmindCheckpoint(workspace);
  assert.equal(current.ok, true); assert.equal(current.status, 'valid-current');
  assert.equal(current.binding.ok, true);
});

test('implicit verification requires the active Pinmind binding for currentness', async () => {
  const { workspace, runId } = await fixture();
  await checkpointPinmind(workspace, runId);
  await unlink(path.join(workspace, '.pinmind', 'active.json'));
  assert.equal((await verifyPinmindCheckpoint(workspace)).status, 'valid-stale');
  assert.equal((await verifyPinmindCheckpoint(workspace, runId)).status, 'valid-stale');
});

test('a corrupt journal prevents unchanged checkpoint success', async () => {
  const { workspace, runId } = await fixture();
  await checkpointPinmind(workspace, runId);
  await writeFile(checkpointAuditPath(workspace), '{bad\n');
  const verified = await verifyPinmindCheckpoint(workspace, runId);
  assert.equal(verified.ok, false); assert.equal(verified.status, 'invalid');
  await assert.rejects(checkpointPinmind(workspace, runId), /saved Pinmind checkpoint is invalid/);
});

test('a Pinmind source mutation between checkpoint calls records a new snapshot', async () => {
  const { workspace, runId, run } = await fixture();
  await checkpointPinmind(workspace, runId);
  await writeFile(path.join(run, 'state.json'), JSON.stringify({ runId, status: 'active', phase: 'verify', currentContractVersion: 1, updatedAt: '2026-09-05T00:01:00.000Z' }));
  const next = await checkpointPinmind(workspace, runId);
  assert.equal(next.unchanged, false); assert.equal(next.phase, 'verify');
  assert.equal((await verifyPinmindCheckpoint(workspace, runId)).status, 'valid-current');
});

test('checkpoint recovery completes only an interrupted matching metadata pair', async () => {
  const { workspace, runId } = await fixture();
  await checkpointPinmind(workspace, runId);
  const checkpoint = JSON.parse(await readFile(checkpointPath(workspace), 'utf8'));
  const checkpointSha256 = sha256(stableJson(checkpoint));
  const pending = {
    protocol: 'codex-skillstate/checkpoint-transaction/1', schemaVersion: 1, checkpoint, checkpointSha256,
    auditData: { protocol: checkpoint.protocol, runId, phase: checkpoint.phase, stateSha256: checkpoint.source.stateSha256, activeSha256: checkpoint.source.activeSha256, checkpointSha256 },
    createdAt: new Date().toISOString(),
  };
  await unlink(checkpointAuditPath(workspace));
  await writeFile(checkpointPendingPath(workspace), JSON.stringify(pending));
  const interrupted = await verifyPinmindCheckpoint(workspace, runId);
  assert.equal(interrupted.ok, false); assert.equal(interrupted.status, 'invalid');
  assert.match(interrupted.error, /checkpoint-recover/);
  const recovered = await recoverPinmindCheckpoint(workspace);
  assert.equal(recovered.recovered, true);
  assert.equal((await verifyPinmindCheckpoint(workspace, runId)).status, 'valid-current');
});

test('recovery refuses a changed active run and leaves pending metadata intact', async () => {
  const { workspace, runId } = await fixture();
  await checkpointPinmind(workspace, runId);
  const checkpoint = JSON.parse(await readFile(checkpointPath(workspace), 'utf8'));
  const checkpointSha256 = sha256(stableJson(checkpoint));
  await writeFile(checkpointPendingPath(workspace), JSON.stringify({
    protocol: 'codex-skillstate/checkpoint-transaction/1', schemaVersion: 1, checkpoint, checkpointSha256,
    auditData: { protocol: checkpoint.protocol, runId, phase: checkpoint.phase, stateSha256: checkpoint.source.stateSha256, activeSha256: checkpoint.source.activeSha256, checkpointSha256 },
    createdAt: new Date().toISOString(),
  }));
  await writeFile(path.join(workspace, '.pinmind', 'active.json'), JSON.stringify({ runId: 'other-run' }));
  await assert.rejects(recoverPinmindCheckpoint(workspace), /stale, foreign, or changed/);
  await readFile(checkpointPendingPath(workspace), 'utf8');
});

test('recovery refuses a changed state snapshot and preserves pending metadata', async () => {
  const { workspace, runId, run } = await fixture();
  await checkpointPinmind(workspace, runId);
  const checkpoint = JSON.parse(await readFile(checkpointPath(workspace), 'utf8'));
  const checkpointSha256 = sha256(stableJson(checkpoint));
  await unlink(checkpointAuditPath(workspace));
  await writeFile(checkpointPendingPath(workspace), JSON.stringify({
    protocol: 'codex-skillstate/checkpoint-transaction/1', schemaVersion: 1, checkpoint, checkpointSha256,
    auditData: { protocol: checkpoint.protocol, runId, phase: checkpoint.phase, stateSha256: checkpoint.source.stateSha256, activeSha256: checkpoint.source.activeSha256, checkpointSha256 },
    createdAt: new Date().toISOString(),
  }));
  await writeFile(path.join(run, 'state.json'), JSON.stringify({ runId, status: 'active', phase: 'verify', currentContractVersion: 1, updatedAt: '2026-09-05T00:01:00.000Z' }));
  await assert.rejects(recoverPinmindCheckpoint(workspace), /stale, foreign, or changed/);
  await readFile(checkpointPendingPath(workspace), 'utf8');
  await assert.rejects(readFile(checkpointAuditPath(workspace), 'utf8'), /ENOENT/);
});

test('a checkpoint lock makes concurrent checkpoint calls fail closed', async () => {
  const { workspace, runId } = await fixture();
  const lock = path.join(path.dirname(checkpointPath(workspace)), 'checkpoint.lock');
  await mkdir(path.dirname(lock), { recursive: true });
  const handle = await open(lock, 'wx', 0o600);
  try { await assert.rejects(checkpointPinmind(workspace, runId), /checkpoint is busy/); }
  finally { await handle.close(); await unlink(lock); }
  assert.equal((await checkpointPinmind(workspace, runId)).unchanged, false);
});

test('legacy v1 checkpoint remains recognizable when its source journal is intact', async () => {
  const { workspace, runId } = await fixture();
  await checkpointPinmind(workspace, runId);
  const current = JSON.parse(await readFile(checkpointPath(workspace), 'utf8'));
  const legacy = { ...current, protocol: 'codex-skillstate/pinmind-checkpoint/1' };
  delete legacy.schemaVersion;
  const unsigned = { at: new Date().toISOString(), event: 'pinmind_checkpoint', data: { runId, phase: legacy.phase, stateSha256: legacy.source.stateSha256 }, previousHash: '0'.repeat(64) };
  const entry = { ...unsigned, hash: sha256(stableJson(unsigned)) };
  await writeFile(checkpointPath(workspace), JSON.stringify(legacy));
  await writeFile(checkpointAuditPath(workspace), `${JSON.stringify(entry)}\n`);
  const result = await verifyPinmindCheckpoint(workspace, runId);
  assert.equal(result.ok, true); assert.equal(result.status, 'valid-current');
  assert.equal(result.binding.legacy, true);
});

test('passive doctor validates the active Pinmind state without probing a controller', async () => {
  const { workspace, runId } = await fixture();
  const healthy = await doctor({ workspace });
  assert.equal(healthy.ok, true); assert.equal(healthy.mode, 'passive-checkpoint');
  assert.equal(healthy.checks.find(check => check.name === 'pinmind-state').runId, runId);
  const empty = await mkdtemp(path.join(os.tmpdir(), 'skillstate-empty-doctor-'));
  cleanups.push(empty);
  const missing = await doctor({ workspace: empty });
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.find(check => check.name === 'pinmind-state').ok, false);
});
