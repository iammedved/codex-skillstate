#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';

const emit = value => writeFileSync(1, `${JSON.stringify(value)}\n`);

if (process.argv[2] === '--version') {
  writeFileSync(1, 'codex-cli fake\n');
  process.exit(0);
}

const prompt = process.argv.at(-1);
if (process.env.SKILLSTATE_FAKE_LOG) appendFileSync(process.env.SKILLSTATE_FAKE_LOG, `${JSON.stringify({ pid: process.pid, prompt })}\n`);
if (process.env.SKILLSTATE_FAKE_MODE === 'tool') {
  emit({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } });
  process.exit(0);
}

const sha = prompt.match(/Current state SHA-256: ([a-f0-9]{64})/)?.[1];
const revision = Number(prompt.match(/"revision":(\d+)/)?.[1] ?? -1);
const response = revision === 0
  ? { baseStateSha256: sha, state_patch: { facts: ['example.txt was read'], nextAction: 'finish' }, action: { type: 'read_file', path: 'example.txt', maxBytes: 1024 } }
  : { baseStateSha256: sha, state_patch: { nextAction: null }, action: { type: 'finish', result: 'Read-only inspection complete.' } };
emit({ type: 'debug', private: 'DO_NOT_FORWARD_42' });
emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } });
emit({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } });
