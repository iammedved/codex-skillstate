import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { appendAudit, runDir } from './audit.mjs';
import { acquireWorkspaceLock, releaseWorkspaceLock } from './runtime.mjs';
import { sha256 } from './util.mjs';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STATE_BYTES = 128 * 1024;

export const checkpointPath = workspace => path.join(runDir(workspace), 'pinmind-checkpoint.json');

async function readContainedFile(workspace, relative, { optional = false } = {}) {
  const file = path.join(workspace, relative);
  let stat;
  try { stat = await lstat(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error(`${relative} must be a regular file no larger than ${MAX_STATE_BYTES} bytes`);
  const [root, resolved] = await Promise.all([realpath(workspace), realpath(file)]);
  if (path.relative(root, resolved).startsWith('..')) throw new Error(`${relative} escapes the workspace`);
  const bytes = await readFile(resolved);
  return { bytes, sha256: sha256(bytes) };
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

async function readLatest(workspace) {
  try { return JSON.parse(await readFile(checkpointPath(workspace), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function checkpointPinmind(workspace, runId) {
  if (!RUN_ID.test(runId ?? '')) throw new Error('--pinmind-run must be a safe run id');
  const lock = await acquireWorkspaceLock(workspace);
  try {
    const relativeState = path.join('.pinmind', 'runs', runId, 'state.json');
    const [stateFile, activeFile] = await Promise.all([
      readContainedFile(workspace, relativeState),
      readContainedFile(workspace, path.join('.pinmind', 'active.json'), { optional: true }),
    ]);
    let state;
    try { state = JSON.parse(stateFile.bytes); } catch { throw new Error(`${relativeState} is invalid JSON`); }
    const boundedName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
    if (state.runId !== runId || !boundedName(state.status) || !boundedName(state.phase) || typeof state.updatedAt !== 'string' || state.updatedAt.length > 64 || (state.currentContractVersion !== null && state.currentContractVersion !== undefined && (!Number.isInteger(state.currentContractVersion) || state.currentContractVersion < 1))) throw new Error(`${relativeState} is not a valid Pinmind state summary`);
    if (activeFile) {
      let active;
      try { active = JSON.parse(activeFile.bytes); } catch { throw new Error('.pinmind/active.json is invalid JSON'); }
      if (active.runId !== runId) throw new Error('.pinmind/active.json points to another run');
    }
    const source = { stateSha256: stateFile.sha256, activeSha256: activeFile?.sha256 ?? null };
    const previous = await readLatest(workspace);
    if (previous?.source?.stateSha256 === source.stateSha256 && previous?.source?.activeSha256 === source.activeSha256) return { ...previous, unchanged: true };
    const checkpoint = {
      protocol: 'codex-skillstate/pinmind-checkpoint/1',
      origin: 'pinmind',
      runId,
      status: state.status,
      phase: state.phase,
      currentContractVersion: state.currentContractVersion ?? null,
      source,
      recordedAt: new Date().toISOString(),
    };
    await atomicWrite(checkpointPath(workspace), checkpoint);
    await appendAudit(workspace, 'pinmind_checkpoint', { runId, phase: checkpoint.phase, stateSha256: source.stateSha256 });
    return { ...checkpoint, unchanged: false };
  } finally { await releaseWorkspaceLock(lock); }
}

export async function showPinmindCheckpoint(workspace) {
  const checkpoint = await readLatest(workspace);
  if (!checkpoint) throw new Error('no Pinmind checkpoint exists for this workspace');
  return checkpoint;
}
