import { bounded, runId, sha256 } from './util.mjs';

export const PROTECTED_FIELDS = new Set(['runId', 'protocol', 'revision', 'authority', 'lifecycle', 'frozen', 'objective', 'receipts']);
export const STATE_SECTIONS = ['facts', 'decisions', 'files', 'verification', 'blockers', 'failedApproaches', 'nextAction', 'finalResult'];

export function createState({ objective, authority = { localMutation: false, externalEffects: false }, frozen = [] }) {
  const state = { runId: runId(), protocol: 'codex-skillstate/0.1', revision: 0, authority, lifecycle: 'active', frozen, objective,
    facts: [], decisions: [], files: [], verification: [], blockers: [], failedApproaches: [], nextAction: null, finalResult: null, receipts: [] };
  validateState(state);
  return state;
}

export function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state must be an object');
  for (const key of ['runId', 'protocol', 'objective', 'lifecycle']) if (typeof state[key] !== 'string' || !state[key]) throw new Error(`state.${key} is required`);
  if (!['active', 'awaiting_user', 'finished', 'paused'].includes(state.lifecycle)) throw new Error('state.lifecycle is invalid');
  if (state.objective.length > 12000) throw new Error('state.objective exceeds 12000 characters');
  if (!Number.isInteger(state.revision) || state.revision < 0) throw new Error('state.revision must be a non-negative integer');
  if (!state.authority || typeof state.authority !== 'object' || Array.isArray(state.authority) || typeof state.authority.localMutation !== 'boolean' || state.authority.externalEffects !== false) throw new Error('state.authority is invalid');
  if (!Array.isArray(state.frozen) || !Array.isArray(state.receipts)) throw new Error('state frozen/receipts must be arrays');
  for (const key of ['facts', 'decisions', 'files', 'verification', 'blockers', 'failedApproaches']) {
    bounded(state[key], 50, `state.${key}`);
    if (state[key].some(item => typeof item !== 'string' || item.length > 4000)) throw new Error(`state.${key} items must be bounded strings`);
  }
  for (const key of ['nextAction', 'finalResult']) if (key in state && state[key] !== null && (typeof state[key] !== 'string' || state[key].length > 24000)) throw new Error(`state.${key} must be a bounded string or null`);
  if (state.frozen.length > 32 || state.receipts.length > 100) throw new Error('state exceeds bounded history limits');
  if (Buffer.byteLength(JSON.stringify(state)) > 131072) throw new Error('state exceeds 128 KiB');
  return state;
}

export function mergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('state_patch must be an object');
  const output = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) output[key] = mergePatch(target[key], value);
    else output[key] = value;
  }
  return output;
}

export function applyStatePatch(state, envelope) {
  if (!envelope || typeof envelope !== 'object') throw new Error('controller response must be an object');
  if (envelope.baseStateSha256 !== sha256(state)) throw new Error('state_patch baseStateSha256 does not match current state');
  const patch = envelope.state_patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('state_patch is required');
  for (const key of Object.keys(patch)) if (!STATE_SECTIONS.includes(key)) throw new Error(`controller cannot add state field: ${key}`);
  for (const key of Object.keys(patch)) if (PROTECTED_FIELDS.has(key)) throw new Error(`controller cannot change protected field: ${key}`);
  const next = mergePatch(state, patch);
  next.revision = state.revision + 1;
  validateState(next);
  return next;
}
