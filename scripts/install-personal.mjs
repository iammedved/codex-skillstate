#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0-experimental";
const MARKER = ".codex-skillstate-install.json";
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.HOME;
if (!home) throw new Error("HOME is required.");

const installRoot = resolve(home, ".local/share/codex-skillstate", VERSION);
const binPath = resolve(home, ".local/bin/skillstate");
const skillPath = resolve(home, ".agents/skills/skillstate-runtime");
const backupRoot = resolve(home, ".local/share/codex-skillstate/backups");
const marker = JSON.stringify({ name: "codex-skillstate", version: VERSION }, null, 2) + "\n";
const wrapper = `#!/usr/bin/env sh\n# codex-skillstate managed wrapper\nset -eu\nbase=$(CDPATH= cd -- "$(dirname -- "$0")/../share/codex-skillstate/${VERSION}" && pwd)\nexec node "$base/bin/skillstate.mjs" "$@"\n`;

async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function managedDirectory(path) { try { return (await readFile(resolve(path, MARKER), "utf8")) === marker; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function replaceManagedDirectory(path, populate, backupDirectory) {
  if (await exists(path)) {
    if (!(await managedDirectory(path))) throw new Error(`Refusing to replace unmanaged path: ${path}`);
    const backup = backupDirectory ? resolve(backupDirectory, `${basename(path)}-${Date.now()}`) : `${path}.previous-${Date.now()}`;
    await mkdir(dirname(backup), { recursive: true });
    await rename(path, backup);
  }
  await mkdir(path, { recursive: true });
  await populate();
  await writeFile(resolve(path, MARKER), marker, "utf8");
}
async function replaceManagedFile(path, contents) {
  if (await exists(path)) {
    const existing = await readFile(path, "utf8");
    if (!existing.includes("# codex-skillstate managed wrapper")) throw new Error(`Refusing to replace unmanaged file: ${path}`);
    await rename(path, `${path}.previous-${Date.now()}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode: 0o755 });
}
async function assertReplaceableDirectory(path) {
  if ((await exists(path)) && !(await managedDirectory(path))) throw new Error(`Refusing to replace unmanaged path: ${path}`);
}
async function assertReplaceableFile(path) {
  if ((await exists(path)) && !(await readFile(path, "utf8")).includes("# codex-skillstate managed wrapper")) {
    throw new Error(`Refusing to replace unmanaged file: ${path}`);
  }
}

if (!(await exists(resolve(sourceRoot, "bin/skillstate.mjs")))) throw new Error("Missing bin/skillstate.mjs; run this installer from a complete release checkout.");
if (!(await exists(resolve(sourceRoot, "skills/skillstate-runtime/SKILL.md")))) throw new Error("Missing skills/skillstate-runtime/SKILL.md; run this installer from a complete release checkout.");
await assertReplaceableDirectory(installRoot);
await assertReplaceableDirectory(skillPath);
await assertReplaceableFile(binPath);

await replaceManagedDirectory(installRoot, () => cp(sourceRoot, installRoot, {
  recursive: true,
  filter: path => ![".git", ".pinmind", "node_modules"].includes(path.split("/").at(-1))
}));
await replaceManagedFile(binPath, wrapper);
await replaceManagedDirectory(skillPath, () => cp(resolve(sourceRoot, "skills/skillstate-runtime"), skillPath, { recursive: true }), backupRoot);
console.log(`Installed Codex Skillstate ${VERSION}.`);
console.log(`Runtime: ${installRoot}`);
console.log(`Skill: ${skillPath}`);
console.log(`Ensure ${resolve(home, ".local/bin")} is on PATH, then start a new Codex chat.`);
