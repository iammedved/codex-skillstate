import { lstat, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { spawnCapture } from './controller.mjs';
import { workspacePath, sha256 } from './util.mjs';
import { stateRoot } from './audit.mjs';
import path from 'node:path';

export const ACTIONS = new Set(['read_file', 'search', 'git_diff', 'snapshot', 'apply_patch', 'ask', 'finish', 'worker']);
const EXTERNAL = /\b(push|pr\b|pull request|deploy|publish|send|message|payment|production|credential|secret)\b/i;

export function validateAction(action, { mode, authority }) {
  if (!action || typeof action !== 'object' || !ACTIONS.has(action.type)) throw new Error('invalid action type');
  if (Object.keys(action).some(key => !['type', 'path', 'query', 'maxBytes', 'patch', 'question', 'result', 'task'].includes(key))) throw new Error('action contains unsupported fields');
  if (action.type === 'worker' && mode !== 'hybrid') throw new Error('worker action is only allowed in hybrid mode');
  if ((action.type === 'apply_patch' || action.type === 'worker') && !authority.localMutation) throw new Error('local mutation is not authorized');
  if (action.type === 'worker' && EXTERNAL.test(action.task || '')) throw new Error('external-effect action is prohibited');
  if (action.type === 'read_file' && typeof action.path !== 'string') throw new Error('read_file requires path');
  if (action.type === 'search' && (typeof action.query !== 'string' || !action.query)) throw new Error('search requires query');
  if (action.type === 'ask' && (typeof action.question !== 'string' || action.question.length > 12000)) throw new Error('ask requires a bounded question');
  if (action.type === 'finish' && (typeof action.result !== 'string' || action.result.length > 24000)) throw new Error('finish requires a bounded result');
  if (action.type === 'apply_patch' && (typeof action.patch !== 'string' || action.patch.length > 200000)) throw new Error('patch must be a bounded string');
  if (action.type === 'read_file' && action.maxBytes != null && (!Number.isInteger(action.maxBytes) || action.maxBytes < 1 || action.maxBytes > 65536)) throw new Error('maxBytes must be 1..65536');
  return action;
}

export async function executeAction({ action, workspace, mode, authority, codex = 'codex' }) {
  validateAction(action, { mode, authority });
  switch (action.type) {
    case 'read_file': {
      const file = await workspacePath(workspace, action.path); const data = await readFile(file);
      const limit = action.maxBytes || 16384; return { type: action.type, path: action.path, content: data.subarray(0, limit).toString('utf8'), truncated: data.length > limit };
    }
    case 'search': return { type: action.type, matches: await search(workspace, action.query, action.path || '.') };
    case 'git_diff': return { type: action.type, ...(await spawnCapture('git', ['diff', '--no-ext-diff', '--', '.'], workspace)) };
    case 'snapshot': return { type: action.type, ...(await snapshot(workspace)) };
    case 'apply_patch': return applyPatch(workspace, action.patch);
    case 'ask': return { type: action.type, question: action.question || 'Clarification required' };
    case 'finish': return { type: action.type, result: action.result || '' };
    case 'worker': return runWorker({ codex, workspace, task: action.task });
  }
}

async function search(workspace, query, relative = '.') {
  if (typeof query !== 'string' || !query || query.length > 256) throw new Error('query must be 1..256 characters');
  const start = relative === '.' ? workspace : await workspacePath(workspace, relative);
  const matches = []; const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || matches.length >= 100) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) { const info = await lstat(file); if (info.size > 65536) continue; const text = await readFile(file, 'utf8').catch(() => ''); if (text.includes(query)) matches.push(path.relative(workspace, file)); }
    }
  }; await walk(start); return matches;
}

async function snapshot(workspace) {
  const status = await spawnCapture('git', ['status', '--porcelain=v1'], workspace);
  const head = await spawnCapture('git', ['rev-parse', 'HEAD'], workspace);
  return { status: status.stdout, head: head.code === 0 ? head.stdout.trim() : null, fingerprint: sha256(`${status.stdout}\n${head.stdout}`) };
}

function validatePatchPaths(patch) {
  for (const line of patch.split('\n')) if (line.startsWith('--- ') || line.startsWith('+++ ')) {
    const file = line.slice(4).trim().split('\t')[0]; if (file === '/dev/null') continue;
    const relative = file.replace(/^[ab]\//, '');
    if (!/^[ab]\//.test(file) || file.includes('..') || path.isAbsolute(file) || relative === '.git' || relative.startsWith('.git/')) throw new Error('patch contains an unsafe path');
  }
}

async function applyPatch(workspace, patch) {
  validatePatchPaths(patch);
  const pending = path.join(stateRoot(), `${sha256(path.resolve(workspace)).slice(0, 24)}.pending-commit.json`);
  await mkdir(path.dirname(pending), { recursive: true }); await writeFile(pending, JSON.stringify({ workspace: path.resolve(workspace), action: { type: 'apply_patch' }, patchSha256: sha256(patch), at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  const result = await spawnCapture('git', ['apply', '--whitespace=nowarn', '-'], workspace, patch);
  return { type: 'apply_patch', applied: result.code === 0, stderr: result.stderr.slice(-4000), pending };
}

async function runWorker({ codex, workspace, task }) {
  if (typeof task !== 'string' || !task || task.length > 12000 || EXTERNAL.test(task)) throw new Error('worker task is invalid or external');
  const result = await spawnCapture(codex, ['exec', '--ephemeral', '--json', '--sandbox', 'workspace-write', task], workspace);
  return { type: 'worker', code: result.code, outputSha256: sha256(result.stdout), stderr: result.stderr.slice(-4000) };
}
