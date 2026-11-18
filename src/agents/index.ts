import type { AgentAdapter } from './types.ts';
import { claude } from './claude.ts';

// Registry. Next adapters: codex (`codex exec --json`), gemini (`gemini -p`), aider.
export const adapters: AgentAdapter[] = [claude];

export function getAdapter(name: string): AgentAdapter {
  const a = adapters.find((x) => x.name === name);
  if (!a) throw new Error(`unknown agent "${name}". Known: ${adapters.map((x) => x.name).join(', ')}`);
  return a;
}
