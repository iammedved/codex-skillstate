#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/util.mjs';

const PRODUCT = 'codex-skillstate';
const MARKER = '.codex-skillstate-install.json';
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => arg !== '--runtime-only' && arg !== '--with-skill') || (args.has('--runtime-only') && args.has('--with-skill'))) throw new Error('Usage: install-personal.mjs [--runtime-only|--with-skill]');
const installSkill = args.has('--with-skill');
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.HOME;
if (!home) throw new Error('HOME is required.');

const installRoot = resolve(home, '.local/share/codex-skillstate', VERSION);
const binPath = resolve(home, '.local/bin/skillstate');
const skillPath = resolve(home, '.agents/skills/skillstate-runtime');
const backupRoot = resolve(home, '.local/share/codex-skillstate/backups');
const marker = JSON.stringify({ name: PRODUCT, version: VERSION }, null, 2) + '\n';
const wrapper = `#!/usr/bin/env sh\n# codex-skillstate managed wrapper\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/../share/codex-skillstate/${VERSION}" && pwd)\nexec node "$base/bin/skillstate.mjs" "$@"\n`;

async function exists(target) { try { await lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function managedDirectory(target) {
  try { return JSON.parse(await readFile(resolve(target, MARKER), 'utf8'))?.name === PRODUCT; }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
}
async function managedWrapper(target) {
  try { return (await readFile(target, 'utf8')).includes('# codex-skillstate managed wrapper'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function movePath(source, target) {
  try { await rename(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const directory = (await lstat(source)).isDirectory();
    await cp(source, target, { recursive: directory });
    await rm(source, { recursive: directory, force: true });
  }
}
async function assertReplaceableDirectory(target) { if ((await exists(target)) && !(await managedDirectory(target))) throw new Error(`Refusing to replace unmanaged path: ${target}`); }
async function assertReplaceableFile(target) { if ((await exists(target)) && !(await managedWrapper(target))) throw new Error(`Refusing to replace unmanaged file: ${target}`); }
function stagePath(target) { return resolve(dirname(target), `.${basename(target)}.skillstate-stage-${process.pid}-${Date.now()}`); }
async function prepareDirectory(target, populate) {
  const staged = stagePath(target);
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  await populate(staged);
  await writeFile(resolve(staged, MARKER), marker, 'utf8');
  return staged;
}
async function replaceDirectory(target, staged, backup) {
  const hadTarget = await exists(target);
  if (hadTarget) await movePath(target, backup);
  await mkdir(dirname(target), { recursive: true });
  try { await movePath(staged, target); }
  catch (error) {
    if (hadTarget && await exists(backup)) await movePath(backup, target);
    throw error;
  }
}
async function replaceFile(target, contents, backup) {
  const staged = stagePath(target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(staged, contents, { mode: 0o755 });
  const hadTarget = await exists(target);
  if (hadTarget) await movePath(target, backup);
  try { await movePath(staged, target); }
  catch (error) {
    if (hadTarget && await exists(backup)) await movePath(backup, target);
    throw error;
  }
}

if (!(await exists(resolve(sourceRoot, 'bin/skillstate.mjs')))) throw new Error('Missing bin/skillstate.mjs; run this installer from a complete release checkout.');
if (installSkill && !(await exists(resolve(sourceRoot, 'skills/skillstate-runtime/SKILL.md')))) throw new Error('Missing skills/skillstate-runtime/SKILL.md; run this installer from a complete release checkout.');
await assertReplaceableDirectory(installRoot);
await assertReplaceableFile(binPath);
if (installSkill) await assertReplaceableDirectory(skillPath);

const backup = resolve(backupRoot, `${Date.now()}-${process.pid}`);
const runtimeBackup = resolve(backup, 'runtime');
const binBackup = resolve(backup, 'skillstate');
const skillBackup = resolve(backup, 'skillstate-runtime');
const runtimeStage = await prepareDirectory(installRoot, target => cp(sourceRoot, target, { recursive: true, filter: entry => !['.git', '.pinmind', 'node_modules'].includes(entry.split('/').at(-1)) }));
const skillStage = installSkill ? await prepareDirectory(skillPath, target => cp(resolve(sourceRoot, 'skills/skillstate-runtime'), target, { recursive: true })) : null;
const replaced = [];

try {
  await mkdir(backup, { recursive: true });
  if (!installSkill && await managedDirectory(skillPath)) {
    await movePath(skillPath, skillBackup);
    replaced.push({ target: skillPath, backup: skillBackup, directory: true });
  }
  await replaceDirectory(installRoot, runtimeStage, runtimeBackup); replaced.push({ target: installRoot, backup: runtimeBackup, directory: true });
  await replaceFile(binPath, wrapper, binBackup); replaced.push({ target: binPath, backup: binBackup, directory: false });
  if (skillStage) { await replaceDirectory(skillPath, skillStage, skillBackup); replaced.push({ target: skillPath, backup: skillBackup, directory: true }); }
} catch (error) {
  for (const item of replaced.reverse()) {
    await rm(item.target, { recursive: item.directory, force: true });
    if (await exists(item.backup)) await movePath(item.backup, item.target);
  }
  throw error;
}

console.log(`Installed Codex Skillstate ${VERSION}.`);
console.log(`Runtime: ${installRoot}`);
console.log(installSkill ? `Skill: ${skillPath}` : 'Skill: plugin-managed; no duplicate personal skill installed.');
console.log(`Ensure ${resolve(home, '.local/bin')} is on PATH, then start a new Codex chat.`);
