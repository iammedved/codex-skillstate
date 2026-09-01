import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { sha256, stableJson } from './util.mjs';

export const stateRoot = () => path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || process.cwd(), '.local/state'), 'codex-skillstate');
export const runDir = workspace => path.join(stateRoot(), sha256(path.resolve(workspace)).slice(0, 24));
export const auditPath = workspace => path.join(runDir(workspace), 'audit.jsonl');
export const auditHeadPath = workspace => path.join(runDir(workspace), 'audit.head.json');
export const auditLockPath = workspace => path.join(runDir(workspace), 'audit.lock');

async function atomicWrite(file, data) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, file);
}

function deadLocalOwner(owner) {
  if (!owner || typeof owner !== 'object' || typeof owner.token !== 'string' || !owner.token || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export async function recoverAuditLock(workspace, confirm = false) {
  const lock = auditLockPath(workspace); let raw;
  try { raw = await readFile(lock, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let owner; try { owner = JSON.parse(raw); } catch { throw new Error('audit lock is not safely recoverable'); }
  if (!confirm) return false;
  if (!deadLocalOwner(owner)) throw new Error('audit lock is not safely recoverable');
  const current = await readFile(lock, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (current === null) return false;
  if (current !== raw) throw new Error('audit lock ownership changed during recovery');
  await unlink(lock);
  return true;
}

async function withAuditLock(workspace, work) {
  const lock = auditLockPath(workspace); await mkdir(path.dirname(lock), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 500; attempt++) {
    try { handle = await open(lock, 'wx', 0o600); await handle.writeFile(JSON.stringify({ token: randomUUID(), pid: process.pid, hostname: os.hostname(), at: new Date().toISOString() })); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  if (!handle) throw new Error('audit is busy');
  try { return await work(); }
  finally { await handle.close().catch(() => {}); await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function readEntries(file) {
  try {
    const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
    let previousHash = '0'.repeat(64);
    for (let index = 0; index < lines.length; index++) {
      let entry; try { entry = JSON.parse(lines[index]); } catch { throw new Error(`audit entry ${index} is invalid JSON`); }
      const { hash, ...unsigned } = entry;
      if (entry.previousHash !== previousHash || hash !== sha256(stableJson(unsigned))) throw new Error(`audit entry ${index} has a hash-chain mismatch`);
      previousHash = hash;
    }
    return { entries: lines.length, hash: previousHash };
  } catch (error) { if (error.code === 'ENOENT') return { entries: 0, hash: '0'.repeat(64) }; throw error; }
}

export async function appendAudit(workspace, event, data = {}) {
  return withAuditLock(workspace, async () => {
    const file = auditPath(workspace); const current = await readEntries(file);
    const entry = { at: new Date().toISOString(), event, data, previousHash: current.hash };
    entry.hash = sha256(stableJson(entry));
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    // The journal is authoritative; this derived head can be rebuilt after a crash.
    await atomicWrite(auditHeadPath(workspace), JSON.stringify({ entries: current.entries + 1, hash: entry.hash }));
    return entry;
  });
}

export async function verifyAudit(workspace) {
  const file = auditPath(workspace); let lines;
  try { lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean); } catch (error) { if (error.code === 'ENOENT') return { ok: true, entries: 0 }; throw error; }
  let previousHash = '0'.repeat(64);
  for (let index = 0; index < lines.length; index++) {
    let entry; try { entry = JSON.parse(lines[index]); } catch { return { ok: false, index, error: 'invalid JSONL' }; }
    const { hash, ...unsigned } = entry;
    if (entry.previousHash !== previousHash || hash !== sha256(stableJson(unsigned))) return { ok: false, index, error: 'hash-chain mismatch' };
    previousHash = hash;
  }
  let head;
  try { head = JSON.parse(await readFile(auditHeadPath(workspace), 'utf8')); }
  catch (error) { return { ok: false, index: lines.length, error: error.code === 'ENOENT' ? 'audit head missing (append an audit event to repair it)' : 'invalid audit head' }; }
  if (head.entries !== lines.length || head.hash !== previousHash) return { ok: false, index: lines.length, error: 'audit head mismatch' };
  return { ok: true, entries: lines.length, hash: previousHash };
}
