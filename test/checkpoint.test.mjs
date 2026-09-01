import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkpointAuditPath, checkpointPinmind, showPinmindCheckpoint, verifyPinmindCheckpoint } from '../src/checkpoint.mjs';

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
