#!/usr/bin/env node
import { lstat, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VERSION } from '../src/util.mjs';

const PRODUCT = 'codex-skillstate';
const MARKER = '.codex-skillstate-install.json';
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => arg !== '--with-skill')) throw new Error('Usage: uninstall-personal.mjs [--with-skill]');
const home = process.env.HOME;
if (!home) throw new Error('HOME is required.');
const targets = [
  { path: resolve(home, '.local/share/codex-skillstate', VERSION), wrapper: false },
  { path: resolve(home, '.local/bin/skillstate'), wrapper: true },
  ...(args.has('--with-skill') ? [{ path: resolve(home, '.agents/skills/skillstate-runtime'), wrapper: false }] : [])
];
async function exists(target) { try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function managedDirectory(target) {
  try { return JSON.parse(await readFile(resolve(target, MARKER), 'utf8'))?.name === PRODUCT; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}
for (const target of targets) {
  if (!(await exists(target.path))) continue;
  const managed = target.wrapper ? (await readFile(target.path, 'utf8')).includes('# codex-skillstate managed wrapper') : await managedDirectory(target.path);
  if (!managed) throw new Error(`Refusing to remove unmanaged ${target.wrapper ? 'file' : 'path'}: ${target.path}`);
  await rm(target.path, { recursive: !target.wrapper, force: false });
  console.log(`Removed ${target.path}`);
}
