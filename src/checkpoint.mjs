import { appendFile, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { sha256, stableJson } from './util.mjs';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STATE_BYTES = 128 * 1024;

const checkpointDir = workspace => path.join(workspace, '.pinmind', 'skillstate');
export const checkpointPath = workspace => path.join(checkpointDir(workspace), 'checkpoint.json');
export const checkpointAuditPath = workspace => path.join(checkpointDir(workspace), 'audit.jsonl');

async function withCheckpointLock(workspace, work) {
  const directory = checkpointDir(workspace);
  await mkdir(directory, { recursive: true });
  const [root, resolved, stat] = await Promise.all([realpath(workspace), realpath(directory), lstat(directory)]);
  if (!stat.isDirectory() || path.relative(root, resolved).startsWith('..')) throw new Error('Pinmind Skillstate directory escapes the workspace');
  const lock = path.join(resolved, 'checkpoint.lock');
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Pinmind checkpoint is busy'); throw error; }
  try { return await work(); }
  finally { await handle.close(); await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function readCheckpointAudit(workspace) {
  let lines;
  try { lines = (await readFile(checkpointAuditPath(workspace), 'utf8')).trim().split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return { ok: true, entries: 0, hash: '0'.repeat(64) }; throw error; }
  let previousHash = '0'.repeat(64);
  for (let index = 0; index < lines.length; index++) {
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { return { ok: false, index, error: 'invalid JSONL' }; }
    const { hash, ...unsigned } = entry;
    if (entry.previousHash !== previousHash || hash !== sha256(stableJson(unsigned))) return { ok: false, index, error: 'hash-chain mismatch' };
    previousHash = hash;
  }
  return { ok: true, entries: lines.length, hash: previousHash };
}

async function appendCheckpointAudit(workspace, data) {
  const current = await readCheckpointAudit(workspace);
  if (!current.ok) throw new Error(`Pinmind checkpoint audit is invalid at entry ${current.index}`);
  const entry = { at: new Date().toISOString(), event: 'pinmind_checkpoint', data, previousHash: current.hash };
  entry.hash = sha256(stableJson(entry));
  await appendFile(checkpointAuditPath(workspace), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

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
  return withCheckpointLock(workspace, async () => {
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
    await appendCheckpointAudit(workspace, { runId, phase: checkpoint.phase, stateSha256: source.stateSha256 });
    return { ...checkpoint, unchanged: false };
  });
}

export const verifyPinmindCheckpoint = workspace => readCheckpointAudit(workspace);

export async function showPinmindCheckpoint(workspace) {
  const checkpoint = await readLatest(workspace);
  if (!checkpoint) throw new Error('no Pinmind checkpoint exists for this workspace');
  return checkpoint;
}
