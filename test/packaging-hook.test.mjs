import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { VERSION } from '../src/util.mjs';
import { hookOutputForPrompt } from '../hooks/skillstate-autostart.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(root, 'hooks', 'skillstate-autostart.mjs');
const install = path.join(root, 'scripts', 'install-personal.mjs');

test('release metadata uses one 0.2.0-experimental version', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(VERSION, '0.2.0-experimental');
  assert.equal(packageJson.version, VERSION);
  assert.equal(plugin.version, VERSION);
});

test('plugin registers a bounded UserPromptSubmit hook', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
  const registration = config.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
  assert.equal(registration?.type, 'command');
  assert.match(registration?.command ?? '', /skillstate-autostart\.mjs/);
  assert.ok(registration?.timeout > 0 && registration.timeout <= 5);
});

test('hook stays silent for short prompts and only nudges long multi-stage work', async () => {
  assert.deepEqual(hookOutputForPrompt('Исправь опечатку в README.'), {});
  const result = hookOutputForPrompt('Проведи аудит репозитория, исправь найденные ошибки, добавь тесты и подготовь итоговый отчёт.');
  const context = result.hookSpecificOutput?.additionalContext ?? '';
  assert.equal(result.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(context, /\$skillstate-runtime/);
  assert.match(context, /Automatically use/);
  assert.ok(hookOutputForPrompt(`Сделай ${'подробный план и отчёт '.repeat(18)}`).hookSpecificOutput);
});

test('hook CLI reads Codex JSON stdin and emits routing context', () => {
  const child = spawnSync(process.execPath, [hook], {
    encoding: 'utf8',
    input: JSON.stringify({ prompt: 'Сначала проанализируй проект, затем реализуй исправления и проверь всё тестами.' })
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(JSON.parse(child.stdout).hookSpecificOutput.additionalContext, /\$skillstate-runtime/);
});

test('skill permits implicit invocation', async () => {
  const agent = await readFile(path.join(root, 'skills', 'skillstate-runtime', 'agents', 'openai.yaml'), 'utf8');
  assert.match(agent, /allow_implicit_invocation:\s*true/);
  assert.match(agent, /\$skillstate-runtime/);
});

test('runtime-only install moves an old managed personal skill to a recoverable backup', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'skillstate-install-'));
  const skill = path.join(home, '.agents', 'skills', 'skillstate-runtime');
  const bin = path.join(home, '.local', 'bin', 'skillstate');
  await mkdir(skill, { recursive: true });
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(path.join(skill, '.codex-skillstate-install.json'), JSON.stringify({ name: 'codex-skillstate', version: '0.1.0-experimental' }) + '\n');
  await writeFile(bin, '#!/usr/bin/env sh\n# codex-skillstate managed wrapper\nexit 0\n');

  await execFileAsync(process.execPath, [install, '--runtime-only'], { env: { ...process.env, HOME: home } });

  const marker = JSON.parse(await readFile(path.join(home, '.local', 'share', 'codex-skillstate', VERSION, '.codex-skillstate-install.json'), 'utf8'));
  assert.equal(marker.version, VERSION);
  await assert.rejects(lstat(skill), /ENOENT/);
  const backups = await readdir(path.join(home, '.local', 'share', 'codex-skillstate', 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(home, '.local', 'share', 'codex-skillstate', 'backups', backups[0], 'skillstate-runtime', '.codex-skillstate-install.json'), 'utf8')).version, '0.1.0-experimental');
  assert.match(await readFile(bin, 'utf8'), new RegExp(VERSION));

  await execFileAsync(process.execPath, [install, '--with-skill'], { env: { ...process.env, HOME: home } });
  const upgradedSkill = JSON.parse(await readFile(path.join(skill, '.codex-skillstate-install.json'), 'utf8'));
  assert.equal(upgradedSkill.name, 'codex-skillstate');
  assert.equal(upgradedSkill.version, VERSION);
});

test('runtime-only install leaves an unmanaged personal skill untouched', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'skillstate-install-unmanaged-'));
  const skill = path.join(home, '.agents', 'skills', 'skillstate-runtime');
  await mkdir(skill, { recursive: true }); await writeFile(path.join(skill, 'keep.txt'), 'do not replace');
  await execFileAsync(process.execPath, [install, '--runtime-only'], { env: { ...process.env, HOME: home } });
  assert.equal(await readFile(path.join(skill, 'keep.txt'), 'utf8'), 'do not replace');
});
