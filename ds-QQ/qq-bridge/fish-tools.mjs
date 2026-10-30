import { registerCapture } from './vendor/dsh-fish/lib/capture.js';
import { registerRecall } from './vendor/dsh-fish/lib/recall.js';
import { registerLetter } from './vendor/dsh-fish/lib/letter.js';
import { registerLook } from './vendor/dsh-fish/lib/look.js';
import { COMPANION_TOOL_NAMES, companionDefinitions } from './companion-memory.mjs';

// Only these read/local-growth capabilities are imported. No login, speak, video or reset tool.
export const FISH_TOOL_NAMES = ['growth_commit', 'her_recall', 'her_leave', 'bili_look', ...COMPANION_TOOL_NAMES];
export function fishDefinitions(root, client) {
  const definitions = new Map();
  const ctx = { tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {}; } } };
  for (const register of [registerCapture, registerRecall, registerLetter, registerLook]) register(ctx, { root, client });
  for (const definition of companionDefinitions()) definitions.set(definition.name, definition);
  return definitions;
}
