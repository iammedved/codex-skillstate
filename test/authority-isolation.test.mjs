import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeAction } from '../src/actions.mjs';
import { controllerResponseFromJsonl, runFreshController, spawnCapture } from '../src/controller.mjs';

async function executable(root, name, source) {
  const file = path.join(root, name);
  await writeFile(file, `#!/usr/bin/env node\n${source}`);
  await chmod(file, 0o755);
  return file;
}

test('controller ignores global config and never includes child output in failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillstate-authority-'));
  const log = path.join(root, 'args.json');
  const codex = await executable(root, 'mock-codex.mjs', `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.SKILLSTATE_AUTH_LOG, JSON.stringify(process.argv.slice(2)));
    console.error('SECRET_TOKEN=never-forward-this');
    process.exit(7);
  `);
  const before = process.env.SKILLSTATE_AUTH_LOG;
  process.env.SKILLSTATE_AUTH_LOG = log;
  try {
    await assert.rejects(
      runFreshController({ codex, workspace: root, schemaPath: '/schema.json', prompt: 'inspect' }),
      error => /controller failed \(7\)/.test(error.message) && !error.message.includes('SECRET_TOKEN')
    );
    const args = JSON.parse(await readFile(log, 'utf8'));
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('--ignore-rules'));
  } finally {
    if (before === undefined) delete process.env.SKILLSTATE_AUTH_LOG;
    else process.env.SKILLSTATE_AUTH_LOG = before;
    await rm(root, { recursive: true, force: true });
  }
});

test('controller fails closed for unknown item types that could be tools', () => {
  const jsonl = JSON.stringify({ type: 'item.completed', item: { type: 'web_search_call', query: 'must not run' } });
  assert.throws(() => controllerResponseFromJsonl(jsonl), /forbidden|unrecognized/i);
});

test('shared child runner times out without returning stdout or stderr', async () => {
  await assert.rejects(
    spawnCapture(process.execPath, ['-e', "console.log('SECRET_TOKEN=hidden'); setInterval(() => {}, 1000)"], process.cwd(), undefined, { timeoutMs: 30, killGraceMs: 10 }),
    error => /timed out/.test(error.message) && !error.message.includes('SECRET_TOKEN')
  );
});

test('timeout stops the child process group on Unix', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillstate-process-group-'));
  const pidFile = path.join(root, 'grandchild.pid');
  const parent = await executable(root, 'parent.mjs', `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
    writeFileSync(process.env.SKILLSTATE_GRANDCHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
  `);
  const before = process.env.SKILLSTATE_GRANDCHILD_PID;
  process.env.SKILLSTATE_GRANDCHILD_PID = pidFile;
  try {
    await assert.rejects(spawnCapture(parent, [], root, undefined, { timeoutMs: 200, killGraceMs: 20 }), /timed out/);
    await new Promise(resolve => setTimeout(resolve, 80));
    const pid = Number(await readFile(pidFile, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    assert.equal(alive, false);
  } finally {
    if (before === undefined) delete process.env.SKILLSTATE_GRANDCHILD_PID;
    else process.env.SKILLSTATE_GRANDCHILD_PID = before;
    await rm(root, { recursive: true, force: true });
  }
});

test('worker is read-only, carries authority context, and returns only hashes and metrics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skillstate-worker-'));
  const log = path.join(root, 'worker.json');
  const codex = await executable(root, 'mock-worker.mjs', `
    import { writeFileSync } from 'node:fs';
    writeFileSync(process.env.SKILLSTATE_WORKER_LOG, JSON.stringify(process.argv.slice(2)));
    writeFileSync(1, '{"usage":{"input_tokens":3,"output_tokens":2}}\\n');
    writeFileSync(2, 'SECRET_TOKEN=worker-hidden\\n');
  `);
  const before = process.env.SKILLSTATE_WORKER_LOG;
  process.env.SKILLSTATE_WORKER_LOG = log;
  try {
    const result = await executeAction({
      action: { type: 'worker', task: 'Inspect the repository and report only a short summary.' },
      workspace: root,
      mode: 'hybrid',
      authority: { localMutation: false, externalEffects: false },
      codex
    });
    assert.equal(result.type, 'worker');
    assert.equal(typeof result.outputSha256, 'string');
    assert.equal('stdout' in result, false);
    assert.equal('stderr' in result, false);
    assert.deepEqual(result.tokenMetrics, { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 });
    const args = JSON.parse(await readFile(log, 'utf8'));
    assert.ok(args.includes('--sandbox'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('--ignore-user-config'));
    assert.ok(args.includes('--ignore-rules'));
    assert.match(args.at(-1), /"externalEffects":false/);
  } finally {
    if (before === undefined) delete process.env.SKILLSTATE_WORKER_LOG;
    else process.env.SKILLSTATE_WORKER_LOG = before;
    await rm(root, { recursive: true, force: true });
  }
});
