import type { AgentAdapter } from './types.ts';
import { claude } from './claude.ts';
import { agy } from './agy.ts';
import { gemini } from './gemini.ts';

// Registry. gemini is kept for paid-API-key users; free users should use agy.
// Next adapters: codex (`codex exec --json`), aider.
export const adapters: AgentAdapter[] = [claude, agy, gemini];

const ALIASES: Record<string, string> = { antigravity: 'agy' };

export function getAdapter(name: string): AgentAdapter {
  const a = adapters.find((x) => x.name === (ALIASES[name] ?? name));
  if (!a) throw new Error(`unknown agent "${name}". Known: ${adapters.map((x) => x.name).join(', ')}`);
  return a;
}
