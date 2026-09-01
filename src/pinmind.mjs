import { readFile, realpath } from 'node:fs/promises';
import { sha256 } from './util.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function pinmindAdapter({ pinmindPath, task }) {
  if (!pinmindPath) throw new Error('--pinmind-path is required with --controller pinmind');
  const router = path.join(pinmindPath, 'scripts', 'pinmind.mjs');
  const routeModule = path.join(pinmindPath, 'scripts', 'lib', 'route.mjs');
  const skill = path.join(pinmindPath, 'SKILL.md');
  let route;
  try { route = (await import(pathToFileURL(routeModule))).routeTask({ text: task }); }
  catch (error) { throw new Error(`Pinmind router failed: ${error.message}`); }
  for (const key of ['route', 'clarity', 'executionSpan', 'risk', 'needsHumanConfirmation']) if (!(key in route)) throw new Error(`Pinmind route missing ${key}`);
  const references = [path.join(pinmindPath, 'references', 'route.md')];
  if (route.route === 'software-change') references.push(path.join(pinmindPath, 'references', 'contract.md'), path.join(pinmindPath, 'references', 'loop.md'));
  else if (route.route === 'investigation') references.push(path.join(pinmindPath, 'references', 'loop.md'));
  const frozenPaths = [['pinmind-router', router], ['pinmind-route-module', routeModule], ['pinmind-skill', skill], ...references.map(file => [`pinmind-${path.basename(file, '.md')}`, file])];
  const frozen = await Promise.all(frozenPaths.map(async ([name, file]) => ({ name, path: await realpath(file), sha256: sha256(await readFile(file)) })));
  return { route: route.route, clarity: route.clarity, executionSpan: route.executionSpan, risk: route.risk, needsHumanConfirmation: route.needsHumanConfirmation,
    localMutation: !route.needsHumanConfirmation && route.route === 'software-change', frozen };
}

export async function assertFrozen(frozen) {
  for (const entry of frozen) if (sha256(await readFile(entry.path)) !== entry.sha256) throw new Error(`frozen skill changed during run: ${entry.name}`);
}
