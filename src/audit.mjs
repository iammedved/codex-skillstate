import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256, stableJson } from './util.mjs';

export const stateRoot = () => path.join(process.env.XDG_STATE_HOME || path.join(process.env.HOME || process.cwd(), '.local/state'), 'codex-skillstate');
export const runDir = (workspace) => path.join(stateRoot(), sha256(path.resolve(workspace)).slice(0, 24));
export const auditPath = workspace => path.join(runDir(workspace), 'audit.jsonl');
export const auditHeadPath = workspace => path.join(runDir(workspace), 'audit.head.json');

export async function appendAudit(workspace, event, data = {}) {
  const file = auditPath(workspace); await mkdir(path.dirname(file), { recursive: true });
  let previousHash = '0'.repeat(64); let entries = 0;
  try { const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean); entries = lines.length; if (entries) previousHash = JSON.parse(lines.at(-1)).hash; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entry = { at: new Date().toISOString(), event, data, previousHash };
  entry.hash = sha256(stableJson(entry));
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const head = auditHeadPath(workspace); const temporary = `${head}.tmp`;
  await writeFile(temporary, JSON.stringify({ entries: entries + 1, hash: entry.hash }), { mode: 0o600 });
  await rename(temporary, head);
  return entry;
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
  catch (error) { return { ok: false, index: lines.length, error: error.code === 'ENOENT' ? 'audit head missing' : 'invalid audit head' }; }
  if (head.entries !== lines.length || head.hash !== previousHash) return { ok: false, index: lines.length, error: 'audit head mismatch' };
  return { ok: true, entries: lines.length, hash: previousHash };
}
