import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const VERSION = '0.2.1-experimental';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stableJson(value)).digest('hex');
export const stableJson = value => JSON.stringify(sort(value));
export const runId = () => randomUUID();

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
}

export function parseJson(text, label = 'JSON') {
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); }
}

export async function workspacePath(workspace, candidate, { mustExist = true } = {}) {
  if (typeof candidate !== 'string' || !candidate || path.isAbsolute(candidate)) throw new Error('path must be a non-empty relative path');
  const root = await realpath(workspace);
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('path escapes workspace');
  if (!mustExist) return resolved;
  const stat = await lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error('symlink paths are not allowed');
  const actual = await realpath(resolved);
  if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new Error('path resolves outside workspace');
  return actual;
}

export function bounded(value, max, label) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must contain at most ${max} items`);
  return value;
}
