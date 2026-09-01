import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, sha256 } from './util.mjs';

const forbiddenKey = /^(tool_calls?|command|file_changes?|apply_patch|mcp|function_call)$/i;
const forbiddenType = /(?:tool|command|file.change|mcp|function.call|apply.patch|exec)/i;
const safeItemTypes = new Set(['agent_message', 'message', 'reasoning', 'analysis', 'output_text']);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

export function rejectControllerJsonl(jsonl) {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('controller JSONL contains an invalid event'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('controller JSONL contains an invalid event');
    if (typeof event.type === 'string' && event.type.startsWith('item.')) {
      if (!event.item || typeof event.item !== 'object' || Array.isArray(event.item) || !safeItemTypes.has(event.item.type)) throw new Error('controller used an unrecognized or forbidden tool event');
    }
    const visit = (value, key) => {
      if (!value || typeof value !== 'object') return;
      if (forbiddenKey.test(key || '') || (typeof value.type === 'string' && forbiddenType.test(value.type))) throw new Error('controller used a forbidden tool/command/file-change call');
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    };
    visit(event);
  }
}

export function tokenMetricsFromJsonl(jsonl) {
  let metrics = null;
  for (const line of jsonl.split(/\r?\n/)) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.usage && typeof value.usage === 'object') {
        const inputTokens = value.usage.input_tokens ?? value.usage.inputTokens;
        const cachedInputTokens = value.usage.cached_input_tokens ?? value.usage.cachedInputTokens ?? 0;
        const outputTokens = value.usage.output_tokens ?? value.usage.outputTokens;
        if (Number.isInteger(inputTokens) && Number.isInteger(outputTokens)) metrics = { inputTokens, cachedInputTokens: Number.isInteger(cachedInputTokens) ? cachedInputTokens : 0, outputTokens };
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(event);
  }
  return metrics;
}

export function controllerResponseFromJsonl(jsonl) {
  rejectControllerJsonl(jsonl);
  const values = jsonl.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const candidates = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.text === 'string') candidates.push(value.text);
    if (typeof value.output_text === 'string') candidates.push(value.output_text);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  values.forEach(visit);
  for (const text of candidates.reverse()) {
    try { return parseJson(text, 'controller response'); } catch { /* continue */ }
  }
  for (const value of values.reverse()) if (value.baseStateSha256 && value.state_patch && value.action) return value;
  throw new Error('controller JSONL contains no structured response');
}

export function controllerPrompt({ state, observation, policy, mode }) {
  const { receipts, ...currentState } = state;
  currentState.receiptCount = receipts.length;
  return `You are a stateless controller. Return exactly one JSON object matching the output schema. Do not call tools, commands, or change files.\n\nCurrent state SHA-256: ${sha256(state)}\nCurrent state (compact projection):\n${JSON.stringify(currentState)}\n\nObservation:\n${JSON.stringify(observation)}\n\nPolicy:\n${JSON.stringify(policy)}\n\nChoose exactly one allowed action: read_file, search, git_diff, snapshot, apply_patch, ask, finish${mode === 'hybrid' ? ', worker' : ''}. Inspect before apply_patch. After apply_patch, use git_diff, snapshot${mode === 'hybrid' ? ', or a read-only worker' : ''} before finish. The action must be proportional and no external effects are ever allowed. state_patch is JSON Merge Patch: include all eight schema keys, copy each current array unchanged when it does not change, and use null only to delete nextAction or finalResult. The action object must include every schema field and set unused fields to null. For read_file, expectedSha256 is a previously observed file digest or null. baseStateSha256 must equal the supplied full state hash.`;
}

export async function runFreshController({ codex = 'codex', workspace, schemaPath, prompt }) {
  const args = ['exec', '--ephemeral', '--json', '--ignore-user-config', '--ignore-rules', '--output-schema', schemaPath, '--sandbox', 'read-only', prompt];
  const result = await spawnCapture(codex, args, workspace);
  if (result.code !== 0) throw new Error(`controller failed (${result.code})`);
  const response = controllerResponseFromJsonl(result.stdout);
  Object.defineProperty(response, '_tokenMetrics', { value: tokenMetricsFromJsonl(result.stdout), enumerable: false });
  return response;
}

export async function spawnCapture(command, args, cwd, input, { timeoutMs = DEFAULT_TIMEOUT_MS, killGraceMs = DEFAULT_KILL_GRACE_MS } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(killGraceMs) || killGraceMs < 0) throw new Error('child process timeout options are invalid');
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
    const limit = 2 * 1024 * 1024; let stdout = '', stderr = '', bytes = 0, overflow; let timedOut = false; let settled = false;
    let killTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); if (!timedOut) clearTimeout(killTimer);
      if (error) reject(error); else resolve(result);
    };
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > limit) { overflow ||= new Error('child process output exceeded 2 MiB'); child.kill('SIGKILL'); return; }
      if (target === 'stdout') stdout += chunk; else stderr += chunk;
    };
    const kill = signal => {
      if (grouped && child.pid) {
        try { process.kill(-child.pid, signal); return; }
        catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
      } else child.kill(signal);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), killGraceMs);
    }, timeoutMs);
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', error => finish(error));
    child.on('close', code => finish(overflow || (timedOut ? new Error(`child process timed out after ${timeoutMs}ms`) : null), { code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export const controllerSchemaPath = here => path.join(here, 'schemas', 'controller-output.schema.json');
export async function loadControllerSchema(file) { return JSON.parse(await readFile(file, 'utf8')); }
