import { lstat, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { spawnCapture, tokenMetricsFromJsonl } from './controller.mjs';
import { workspacePath, sha256 } from './util.mjs';
import { stateRoot } from './audit.mjs';
import path from 'node:path';

export const ACTIONS = new Set(['read_file', 'search', 'git_diff', 'snapshot', 'apply_patch', 'ask', 'finish', 'worker']);

export function validateAction(action, { mode, authority }) {
  if (!action || typeof action !== 'object' || !ACTIONS.has(action.type)) throw new Error('invalid action type');
  if (Object.keys(action).some(key => !['type', 'path', 'query', 'maxBytes', 'patch', 'question', 'result', 'task', 'expectedSha256'].includes(key))) throw new Error('action contains unsupported fields');
  if (action.type === 'worker' && mode !== 'hybrid') throw new Error('worker action is only allowed in hybrid mode');
  if (action.type === 'apply_patch' && !authority.localMutation) throw new Error('local mutation is not authorized');
  if (action.type === 'worker' && authority.externalEffects !== false) throw new Error('external-effect authority must be explicitly disabled for worker');
  if (action.type === 'read_file' && typeof action.path !== 'string') throw new Error('read_file requires path');
  if (action.type === 'read_file' && action.expectedSha256 != null && (typeof action.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(action.expectedSha256))) throw new Error('expectedSha256 must be a SHA-256 digest');
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
      const actualSha256 = sha256(data);
      if (action.expectedSha256 && action.expectedSha256 !== actualSha256) throw new Error('read_file SHA-256 mismatch');
      const limit = action.maxBytes || 16384; return { type: action.type, path: action.path, sha256: actualSha256, content: data.subarray(0, limit).toString('utf8'), truncated: data.length > limit };
    }
    case 'search': return { type: action.type, matches: await search(workspace, action.query, action.path || '.') };
    case 'git_diff': return gitDiff(workspace);
    case 'snapshot': return { type: action.type, ...(await snapshot(workspace)) };
    case 'apply_patch': return applyPatch(workspace, action.patch);
    case 'ask': return { type: action.type, question: action.question || 'Clarification required' };
    case 'finish': return { type: action.type, result: action.result || '' };
    case 'worker': return runWorker({ codex, workspace, task: action.task, authority });
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
  return { statusSha256: sha256(status.stdout), changed: status.code === 0 && status.stdout.length > 0, head: head.code === 0 ? head.stdout.trim() : null, fingerprint: sha256(`${status.stdout}\n${head.stdout}`) };
}

async function gitDiff(workspace) {
  const result = await spawnCapture('git', ['diff', '--no-ext-diff', '--', '.'], workspace);
  return { type: 'git_diff', code: result.code, changed: result.code === 0 && result.stdout.length > 0, outputSha256: sha256(result.stdout), outputBytes: Buffer.byteLength(result.stdout) };
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
  return { type: 'apply_patch', applied: result.code === 0, errorSha256: result.stderr ? sha256(result.stderr) : null, pending };
}

async function runWorker({ codex, workspace, task, authority }) {
  if (typeof task !== 'string' || !task || task.length > 12000) throw new Error('worker task is invalid');
  const policy = { authority: { localMutation: Boolean(authority.localMutation), externalEffects: false }, worker: { sandbox: 'read-only', externalEffects: false, output: 'hashes and metrics only' } };
  const prompt = `You are a read-only worker. Do not use tools that change files or cause external effects. Return a concise report.\n\nPolicy:\n${JSON.stringify(policy)}\n\nTask:\n${task}`;
  const result = await spawnCapture(codex, ['exec', '--ephemeral', '--json', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', prompt], workspace);
  return { type: 'worker', code: result.code, outputSha256: sha256(result.stdout), outputBytes: Buffer.byteLength(result.stdout), errorSha256: result.stderr ? sha256(result.stderr) : null, tokenMetrics: tokenMetricsFromJsonl(result.stdout) };
}
