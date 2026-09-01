import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { spawnCapture } from './controller.mjs';
import { sha256 } from './util.mjs';
import path from 'node:path';

export async function pinmindAdapter({ pinmindPath, task }) {
  if (!pinmindPath) throw new Error('--pinmind-path is required with --controller pinmind');
  const router = path.join(pinmindPath, 'scripts', 'pinmind.mjs');
  const skill = path.join(pinmindPath, 'SKILL.md');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'skillstate-pinmind-'));
  const request = path.join(temp, 'request.json');
  let result;
  try { await writeFile(request, JSON.stringify({ text: task }), { mode: 0o600 }); result = await spawnCapture('node', [router, 'route', '--file', request], process.cwd()); }
  finally { await rm(temp, { recursive: true, force: true }); }
  if (result.code !== 0) throw new Error(`Pinmind router failed: ${result.stderr}`);
  let route; try { route = JSON.parse(result.stdout); } catch { throw new Error('Pinmind router returned invalid JSON'); }
  for (const key of ['route', 'clarity', 'executionSpan', 'risk', 'needsHumanConfirmation']) if (!(key in route)) throw new Error(`Pinmind route missing ${key}`);
  const references = [path.join(pinmindPath, 'references', 'route.md')];
  if (route.route === 'software-change') references.push(path.join(pinmindPath, 'references', 'contract.md'), path.join(pinmindPath, 'references', 'loop.md'));
  else if (route.route === 'investigation') references.push(path.join(pinmindPath, 'references', 'loop.md'));
  const frozenPaths = [['pinmind-router', router], ['pinmind-skill', skill], ...references.map(file => [`pinmind-${path.basename(file, '.md')}`, file])];
  const frozen = await Promise.all(frozenPaths.map(async ([name, file]) => ({ name, path: await realpath(file), sha256: sha256(await readFile(file)) })));
  return { route: route.route, clarity: route.clarity, executionSpan: route.executionSpan, risk: route.risk, needsHumanConfirmation: route.needsHumanConfirmation,
    localMutation: !route.needsHumanConfirmation && route.route === 'software-change', frozen };
}

export async function assertFrozen(frozen) {
  for (const entry of frozen) if (sha256(await readFile(entry.path)) !== entry.sha256) throw new Error(`frozen skill changed during run: ${entry.name}`);
}
