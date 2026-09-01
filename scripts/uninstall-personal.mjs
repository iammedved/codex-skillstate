#!/usr/bin/env node
import { lstat, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
const VERSION = "0.1.0-experimental";
const MARKER = ".codex-skillstate-install.json";
const home = process.env.HOME;
if (!home) throw new Error("HOME is required.");
const marker = JSON.stringify({ name: "codex-skillstate", version: VERSION }, null, 2) + "\n";
const targets = [
  { path: resolve(home, ".local/share/codex-skillstate", VERSION), wrapper: false },
  { path: resolve(home, ".agents/skills/skillstate-runtime"), wrapper: false },
  { path: resolve(home, ".local/bin/skillstate"), wrapper: true }
];
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
for (const target of targets) {
  if (!(await exists(target.path))) continue;
  if (target.wrapper) {
    if (!(await readFile(target.path, "utf8")).includes("# codex-skillstate managed wrapper")) throw new Error(`Refusing to remove unmanaged file: ${target.path}`);
  } else {
    let contents;
    try { contents = await readFile(resolve(target.path, MARKER), "utf8"); } catch (error) { if (error.code === "ENOENT") throw new Error(`Refusing to remove unmanaged path: ${target.path}`); throw error; }
    if (contents !== marker) throw new Error(`Refusing to remove unmanaged path: ${target.path}`);
  }
  await rm(target.path, { recursive: !target.wrapper, force: false });
  console.log(`Removed ${target.path}`);
}
