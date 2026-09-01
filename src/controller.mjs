import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseJson, sha256 } from './util.mjs';

const forbidden = /"?(tool_calls?|command|file_changes?|apply_patch)"?\s*:/i;
const forbiddenTypes = /^(command_execution|file_change|mcp_tool_call|tool_call|function_call|apply_patch)$/i;

export function rejectControllerJsonl(jsonl) {
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { if (forbidden.test(line)) throw new Error('controller used a forbidden tool/command/file-change call'); continue; }
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.type === 'string' && forbiddenTypes.test(value.type)) throw new Error('controller used a forbidden tool/command/file-change call');
      if ('tool_call' in value || 'tool_calls' in value || 'command' in value || 'file_changes' in value) throw new Error('controller used a forbidden tool/command/file-change call');
      for (const child of Object.values(value)) visit(child);
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
  return `You are a stateless controller. Return exactly one JSON object matching the output schema. Do not call tools, commands, or change files.\n\nCurrent state SHA-256: ${sha256(state)}\nCurrent state:\n${JSON.stringify(state)}\n\nObservation:\n${JSON.stringify(observation)}\n\nPolicy:\n${JSON.stringify(policy)}\n\nChoose exactly one allowed action: read_file, search, git_diff, snapshot, apply_patch, ask, finish${mode === 'hybrid' ? ', worker' : ''}. The action must be proportional and no external effects are ever allowed. state_patch is JSON Merge Patch: include all eight schema keys, copy each current array unchanged when it does not change, and use null only to delete nextAction or finalResult. The action object must include every schema field and set unused fields to null. baseStateSha256 must equal the supplied state hash.`;
}

export async function runFreshController({ codex = 'codex', workspace, schemaPath, prompt }) {
  const args = ['exec', '--ephemeral', '--json', '--output-schema', schemaPath, '--sandbox', 'read-only', prompt];
  const result = await spawnCapture(codex, args, workspace);
  if (result.code !== 0) throw new Error(`controller failed (${result.code}): ${(result.stdout + '\n' + result.stderr).slice(-6000)}`);
  const response = controllerResponseFromJsonl(result.stdout);
  Object.defineProperty(response, '_tokenMetrics', { value: tokenMetricsFromJsonl(result.stdout), enumerable: false });
  return response;
}

export async function spawnCapture(command, args, cwd, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const limit = 2 * 1024 * 1024; let stdout = '', stderr = '', bytes = 0, overflow;
    const collect = target => chunk => {
      bytes += chunk.length;
      if (bytes > limit) { overflow ||= new Error('child process output exceeded 2 MiB'); child.kill('SIGKILL'); return; }
      if (target === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', reject); child.on('close', code => overflow ? reject(overflow) : resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

export const controllerSchemaPath = here => path.join(here, 'schemas', 'controller-output.schema.json');
export async function loadControllerSchema(file) { return JSON.parse(await readFile(file, 'utf8')); }
