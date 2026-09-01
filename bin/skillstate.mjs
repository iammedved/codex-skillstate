#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../src/util.mjs';
import { verifyAudit } from '../src/audit.mjs';
import { checkpointPinmind, showPinmindCheckpoint } from '../src/checkpoint.mjs';
import { doctor, loadState, recover, run } from '../src/runtime.mjs';

const usage = `skillstate ${VERSION}
Usage:
  skillstate --version | version
  skillstate doctor [--workspace PATH] [--controller codex|pinmind] [--pinmind-path PATH]
  skillstate checkpoint --workspace PATH --pinmind-run RUN_ID
  skillstate checkpoint-show --workspace PATH
  skillstate run --workspace PATH (--task TEXT | --task-file FILE | --resume) [--mode strict|hybrid] [--sandbox read-only|workspace-write] [--controller codex|pinmind] [--pinmind-path PATH] [--max-steps N]
  skillstate show --workspace PATH
  skillstate audit-verify --workspace PATH
  skillstate recover --workspace PATH --confirm`;

export function parseArgs(argv) {
  const [command, ...rest] = argv; const options = {};
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === 'confirm' || key === 'resume') { options[key] = true; continue; }
    const value = rest[++index]; if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    options[key] = value;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === '--version' || command === 'version') return VERSION;
  if (command === '--help' || command === 'help' || !command) return usage;
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  if (command === 'doctor') return doctor({ workspace, controller: options.controller, pinmindPath: options.pinmindPath });
  if (command === 'checkpoint') return checkpointPinmind(workspace, options.pinmindRun);
  if (command === 'checkpoint-show') return showPinmindCheckpoint(workspace);
  if (command === 'show') return loadState(workspace);
  if (command === 'audit-verify') return verifyAudit(workspace);
  if (command === 'recover') return recover(workspace, Boolean(options.confirm));
  if (command === 'run') {
    if (options.task && options.taskFile) throw new Error('use either --task or --task-file');
    if (options.resume && (options.task || options.taskFile)) throw new Error('--resume cannot be combined with --task or --task-file');
    const task = options.task || (options.taskFile && await readFile(options.taskFile, 'utf8'));
    const maxSteps = options.maxSteps === undefined ? undefined : Number(options.maxSteps);
    if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100)) throw new Error('--max-steps must be 1..100');
    return run({ workspace, task, resume: Boolean(options.resume), mode: options.mode, sandbox: options.sandbox, controller: options.controller, pinmindPath: options.pinmindPath, maxSteps });
  }
  throw new Error(`unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().then(value => {
  if (typeof value === 'string') process.stdout.write(`${value}\n`); else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}).catch(error => { process.stderr.write(`skillstate: ${error.message}\n`); process.exitCode = 2; });
