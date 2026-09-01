#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.argv[2] === '--version') {
  console.log('codex-cli fake');
  process.exit(0);
}

const prompt = process.argv.at(-1);
if (process.env.SKILLSTATE_FAKE_LOG) appendFileSync(process.env.SKILLSTATE_FAKE_LOG, `${JSON.stringify({ pid: process.pid, prompt })}\n`);
if (process.env.SKILLSTATE_FAKE_MODE === 'tool') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } }));
  process.exit(0);
}

const sha = prompt.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1];
const revision = Number(prompt.match(/"revision":(\d+)/)?.[1] ?? -1);
const response = revision === 0
  ? { baseStateSha256: sha, state_patch: { facts: ['example.txt was read'], nextAction: 'finish' }, action: { type: 'read_file', path: 'example.txt', maxBytes: 1024 } }
  : { baseStateSha256: sha, state_patch: { nextAction: null }, action: { type: 'finish', result: 'Read-only inspection complete.' } };
console.log(JSON.stringify({ type: 'debug', private: 'DO_NOT_FORWARD_42' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } }));
