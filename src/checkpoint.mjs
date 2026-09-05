import { access, appendFile, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { sha256, stableJson } from './util.mjs';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_STATE_BYTES = 128 * 1024;
const ZERO_HASH = '0'.repeat(64);
const PROTOCOL_V1 = 'codex-skillstate/pinmind-checkpoint/1';
const PROTOCOL_V2 = 'codex-skillstate/pinmind-checkpoint/2';

const checkpointDir = workspace => path.join(workspace, '.pinmind', 'skillstate');
export const checkpointPath = workspace => path.join(checkpointDir(workspace), 'checkpoint.json');
export const checkpointAuditPath = workspace => path.join(checkpointDir(workspace), 'audit.jsonl');
export const checkpointPendingPath = workspace => path.join(checkpointDir(workspace), 'checkpoint.pending.json');

const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const boundedName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

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
  catch (error) { if (error.code === 'ENOENT') return { ok: true, exists: false, entries: 0, hash: ZERO_HASH, records: [] }; throw error; }
  let previousHash = ZERO_HASH; const records = [];
  for (let index = 0; index < lines.length; index++) {
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { return { ok: false, exists: true, index, error: 'invalid JSONL', records }; }
    const { hash, ...unsigned } = entry;
    if (entry.previousHash !== previousHash || hash !== sha256(stableJson(unsigned))) return { ok: false, exists: true, index, error: 'hash-chain mismatch', records };
    records.push(entry); previousHash = hash;
  }
  return { ok: true, exists: true, entries: lines.length, hash: previousHash, records };
}

async function appendCheckpointAudit(workspace, data) {
  const current = await readCheckpointAudit(workspace);
  if (!current.ok) throw new Error(`Pinmind checkpoint audit is invalid at entry ${current.index}`);
  const entry = { at: new Date().toISOString(), event: 'pinmind_checkpoint', data, previousHash: current.hash };
  entry.hash = sha256(stableJson(entry));
  await appendFile(checkpointAuditPath(workspace), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
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

async function readJsonFile(workspace, relative, options) {
  const file = await readContainedFile(workspace, relative, options);
  if (!file) return null;
  try { return { ...file, value: JSON.parse(file.bytes) }; }
  catch { throw new Error(`${relative} is invalid JSON`); }
}

function validateState(state, runId, relativeState) {
  if (state.runId !== runId || !boundedName(state.status) || !boundedName(state.phase) || typeof state.updatedAt !== 'string' || state.updatedAt.length > 64 || (state.currentContractVersion !== null && state.currentContractVersion !== undefined && (!Number.isInteger(state.currentContractVersion) || state.currentContractVersion < 1))) throw new Error(`${relativeState} is not a valid Pinmind state summary`);
}

async function sourceSnapshot(workspace, requestedRunId, { requireActive = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const active = await readJsonFile(workspace, path.join('.pinmind', 'active.json'), { optional: true });
      const runId = requestedRunId ?? active?.value?.runId;
      if (!runId) return { kind: 'missing', detail: 'no active Pinmind run' };
      if (!RUN_ID.test(runId)) return { kind: 'invalid', detail: 'Pinmind active run id is invalid' };
      if (requireActive && !active) return { kind: 'missing', detail: 'Pinmind active state is missing' };
      if (active && active.value.runId !== runId) return { kind: 'foreign', detail: '.pinmind/active.json points to another run' };
      const relativeState = path.join('.pinmind', 'runs', runId, 'state.json');
      const state = await readJsonFile(workspace, relativeState);
      if (!state) return { kind: 'missing', runId, detail: `${relativeState} is missing` };
      validateState(state.value, runId, relativeState);
      const activeAgain = await readJsonFile(workspace, path.join('.pinmind', 'active.json'), { optional: true });
      const stateAgain = await readJsonFile(workspace, relativeState);
      if (active?.sha256 === activeAgain?.sha256 && state.sha256 === stateAgain.sha256) return {
        kind: 'current', runId, state: state.value,
        source: { stateSha256: state.sha256, activeSha256: active?.sha256 ?? null },
      };
    } catch (error) { return { kind: 'invalid', detail: error.message }; }
  }
  return { kind: 'unstable', detail: 'Pinmind state changed during checkpoint snapshot' };
}

function checkpointVersion(checkpoint) {
  if (checkpoint?.protocol === PROTOCOL_V1 && checkpoint?.schemaVersion === undefined) return 1;
  if (checkpoint?.protocol === PROTOCOL_V2 && checkpoint?.schemaVersion === 2) return 2;
  return null;
}

function validateCheckpoint(checkpoint) {
  const version = checkpointVersion(checkpoint);
  if (!version || checkpoint.origin !== 'pinmind' || !RUN_ID.test(checkpoint.runId ?? '') || !boundedName(checkpoint.status) || !boundedName(checkpoint.phase) || typeof checkpoint.recordedAt !== 'string' || checkpoint.recordedAt.length > 64 || !checkpoint.source || !isHash(checkpoint.source.stateSha256) || (checkpoint.source.activeSha256 !== null && !isHash(checkpoint.source.activeSha256)) || (checkpoint.currentContractVersion !== null && checkpoint.currentContractVersion !== undefined && (!Number.isInteger(checkpoint.currentContractVersion) || checkpoint.currentContractVersion < 1))) throw new Error('checkpoint has an invalid format');
  return version;
}

function linkedEntry(audit, checkpoint, version) {
  const checkpointSha256 = sha256(stableJson(checkpoint));
  return audit.records.find(entry => {
    if (entry.event !== 'pinmind_checkpoint' || !entry.data || entry.data.runId !== checkpoint.runId || entry.data.stateSha256 !== checkpoint.source.stateSha256) return false;
    return version === 1 || (entry.data.checkpointSha256 === checkpointSha256 && entry.data.activeSha256 === checkpoint.source.activeSha256 && entry.data.protocol === checkpoint.protocol);
  });
}

async function readCheckpoint(workspace) {
  try { return await readJsonFile(workspace, path.join('.pinmind', 'skillstate', 'checkpoint.json'), { optional: true }); }
  catch (error) { return { invalid: error.message }; }
}

async function readPending(workspace) {
  try { return await readJsonFile(workspace, path.join('.pinmind', 'skillstate', 'checkpoint.pending.json'), { optional: true }); }
  catch (error) { return { invalid: error.message }; }
}

function makePending(checkpoint) {
  const checkpointSha256 = sha256(stableJson(checkpoint));
  return {
    protocol: 'codex-skillstate/checkpoint-transaction/1', schemaVersion: 1,
    checkpoint, checkpointSha256,
    auditData: { protocol: checkpoint.protocol, runId: checkpoint.runId, phase: checkpoint.phase, stateSha256: checkpoint.source.stateSha256, activeSha256: checkpoint.source.activeSha256, checkpointSha256 },
    createdAt: new Date().toISOString(),
  };
}

function validatePending(pending) {
  if (!pending || pending.protocol !== 'codex-skillstate/checkpoint-transaction/1' || pending.schemaVersion !== 1 || typeof pending.createdAt !== 'string' || !isHash(pending.checkpointSha256)) throw new Error('checkpoint recovery metadata has an invalid format');
  const version = validateCheckpoint(pending.checkpoint);
  if (version !== 2 || pending.checkpointSha256 !== sha256(stableJson(pending.checkpoint))) throw new Error('checkpoint recovery metadata does not match its checkpoint');
  const expected = makePending(pending.checkpoint).auditData;
  if (stableJson(expected) !== stableJson(pending.auditData)) throw new Error('checkpoint recovery metadata does not match its audit binding');
}

export async function checkpointPinmind(workspace, runId) {
  if (!RUN_ID.test(runId ?? '')) throw new Error('--pinmind-run must be a safe run id');
  return withCheckpointLock(workspace, async () => {
    const pending = await readPending(workspace);
    if (pending) throw new Error('Pinmind checkpoint recovery is required; run checkpoint-recover after inspecting its verification result');
    const source = await sourceSnapshot(workspace, runId);
    if (source.kind !== 'current') throw new Error(source.detail);
    const previous = await readCheckpoint(workspace);
    if (previous?.invalid) throw new Error(previous.invalid);
    if (previous) {
      const verified = await verifyPinmindCheckpoint(workspace, runId);
      if (!verified.ok) throw new Error(`saved Pinmind checkpoint is ${verified.status}; it must be repaired before recording another checkpoint`);
      if (previous.value.source.stateSha256 === source.source.stateSha256 && previous.value.source.activeSha256 === source.source.activeSha256) return { ...previous.value, unchanged: true };
    }
    const checkpoint = {
      protocol: PROTOCOL_V2, schemaVersion: 2, origin: 'pinmind', runId,
      status: source.state.status, phase: source.state.phase,
      currentContractVersion: source.state.currentContractVersion ?? null,
      source: source.source, recordedAt: new Date().toISOString(),
    };
    const transaction = makePending(checkpoint);
    await atomicWrite(checkpointPendingPath(workspace), transaction);
    await atomicWrite(checkpointPath(workspace), checkpoint);
    await appendCheckpointAudit(workspace, transaction.auditData);
    await unlink(checkpointPendingPath(workspace));
    return { ...checkpoint, unchanged: false };
  });
}

export async function verifyPinmindCheckpoint(workspace, requestedRunId) {
  if (requestedRunId !== undefined && !RUN_ID.test(requestedRunId)) throw new Error('--pinmind-run must be a safe run id');
  const [checkpointFile, pendingFile, audit] = await Promise.all([readCheckpoint(workspace), readPending(workspace), readCheckpointAudit(workspace)]);
  const base = { protocol: 'codex-skillstate/checkpoint-verify/2', ok: false, status: 'invalid', checkpoint: { exists: Boolean(checkpointFile && !checkpointFile.invalid) }, audit: { exists: audit.exists, ok: audit.ok, entries: audit.entries, hash: audit.hash }, pending: { exists: Boolean(pendingFile) } };
  if (checkpointFile?.invalid) return { ...base, error: checkpointFile.invalid };
  if (pendingFile?.invalid) return { ...base, status: 'invalid', error: pendingFile.invalid };
  if (!checkpointFile && !audit.exists) return { ...base, status: 'missing', error: 'checkpoint and journal are missing' };
  if (pendingFile) return { ...base, status: 'invalid', error: 'checkpoint transaction is interrupted; run checkpoint-recover' };
  if (!checkpointFile || !audit.exists || !audit.ok) return { ...base, status: 'invalid', error: !checkpointFile ? 'checkpoint is missing' : !audit.exists ? 'checkpoint journal is missing' : `checkpoint journal is invalid: ${audit.error}` };
  let version;
  try { version = validateCheckpoint(checkpointFile.value); }
  catch (error) { return { ...base, status: 'invalid', error: error.message }; }
  const checkpoint = checkpointFile.value;
  if (requestedRunId && requestedRunId !== checkpoint.runId) return { ...base, status: 'foreign-run', checkpoint: { exists: true, runId: checkpoint.runId, formatVersion: version }, error: 'checkpoint belongs to another run' };
  const entry = linkedEntry(audit, checkpoint, version);
  if (!entry) return { ...base, status: 'invalid', checkpoint: { exists: true, runId: checkpoint.runId, formatVersion: version }, error: version === 1 ? 'legacy checkpoint has no matching journal source record' : 'checkpoint has no matching journal binding' };
  // Without a requested run, currentness comes only from the active Pinmind binding.
  const source = await sourceSnapshot(workspace, checkpoint.runId, { requireActive: requestedRunId === undefined });
  if (source.kind === 'foreign') return { ...base, status: 'foreign-run', checkpoint: { exists: true, runId: checkpoint.runId, formatVersion: version }, binding: { ok: true, legacy: version === 1 }, source: { state: 'foreign-run' }, error: source.detail };
  if (source.kind === 'invalid' || source.kind === 'unstable') return { ...base, status: 'invalid', checkpoint: { exists: true, runId: checkpoint.runId, formatVersion: version }, binding: { ok: true, legacy: version === 1 }, source: { state: source.kind }, error: source.detail };
  const fresh = source.kind === 'current' && source.source.stateSha256 === checkpoint.source.stateSha256 && source.source.activeSha256 === checkpoint.source.activeSha256;
  const status = fresh ? 'valid-current' : 'valid-stale';
  return { ...base, ok: true, status, checkpoint: { exists: true, runId: checkpoint.runId, formatVersion: version, protocol: checkpoint.protocol }, binding: { ok: true, legacy: version === 1, journalHash: entry.hash }, source: { state: fresh ? 'current' : source.kind === 'missing' ? 'missing' : 'stale' } };
}

export async function recoverPinmindCheckpoint(workspace) {
  return withCheckpointLock(workspace, async () => {
    const pending = await readPending(workspace);
    if (!pending) return { recovered: false, reason: 'no pending checkpoint transaction' };
    if (pending.invalid) throw new Error(pending.invalid);
    validatePending(pending.value);
    const transaction = pending.value;
    const source = await sourceSnapshot(workspace, transaction.checkpoint.runId, { requireActive: true });
    if (source.kind !== 'current' || source.source.stateSha256 !== transaction.checkpoint.source.stateSha256 || source.source.activeSha256 !== transaction.checkpoint.source.activeSha256) throw new Error('checkpoint recovery will not modify a stale, foreign, or changed Pinmind run');
    const current = await readCheckpoint(workspace);
    if (current?.invalid) throw new Error(current.invalid);
    if (!current) await atomicWrite(checkpointPath(workspace), transaction.checkpoint);
    else if (sha256(stableJson(current.value)) !== transaction.checkpointSha256) throw new Error('checkpoint recovery will not overwrite a different checkpoint');
    const audit = await readCheckpointAudit(workspace);
    if (!audit.ok) throw new Error(`checkpoint recovery will not modify an invalid journal at entry ${audit.index}`);
    if (!linkedEntry(audit, transaction.checkpoint, 2)) await appendCheckpointAudit(workspace, transaction.auditData);
    await unlink(checkpointPendingPath(workspace));
    return { recovered: true, runId: transaction.checkpoint.runId, checkpointSha256: transaction.checkpointSha256 };
  });
}

export async function doctorPinmindCheckpoint({ workspace, runId } = {}) {
  const checks = [{ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 20, value: process.versions.node }];
  try {
    const [resolved, stat] = await Promise.all([realpath(workspace), lstat(workspace)]);
    checks.push({ name: 'workspace', ok: stat.isDirectory(), value: resolved });
    await access(resolved, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    checks.push({ name: 'checkpoint-path', ok: true, value: checkpointDir(resolved) });
  } catch (error) { checks.push({ name: 'workspace', ok: false, detail: error.message }); return { ok: false, mode: 'passive-checkpoint', checks }; }
  const source = await sourceSnapshot(workspace, runId, { requireActive: !runId });
  checks.push({ name: 'pinmind-state', ok: source.kind === 'current', runId: source.runId ?? runId ?? null, detail: source.kind === 'current' ? undefined : source.detail });
  return { ok: checks.every(check => check.ok), mode: 'passive-checkpoint', checks };
}

export async function showPinmindCheckpoint(workspace) {
  const checkpoint = await readCheckpoint(workspace);
  if (!checkpoint || checkpoint.invalid) throw new Error(checkpoint?.invalid || 'no Pinmind checkpoint exists for this workspace');
  return checkpoint.value;
}
