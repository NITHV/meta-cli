import type { AgentAdapter, AgentEvent } from './types.ts';
import { oneLine, toolDetail, versionOf } from './util.ts';

function preview(content: unknown): string {
  const s = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
      : '';
  return oneLine(s);
}

function parseLine(line: string): AgentEvent[] {
  if (!line.trim()) return [];
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return [{ kind: 'log', text: line }];
  }
  switch (m.type) {
    case 'system':
      return m.subtype === 'init' ? [{ kind: 'start', sessionId: m.session_id, model: m.model }] : [];
    case 'assistant':
      return (m.message?.content ?? []).flatMap((c: any): AgentEvent[] => {
        if (c.type === 'text' && c.text?.trim()) return [{ kind: 'text', text: c.text }];
        if (c.type === 'tool_use') return [{ kind: 'tool', name: c.name, detail: toolDetail(c.input) }];
        return [];
      });
    case 'user':
      return (m.message?.content ?? []).flatMap((c: any): AgentEvent[] =>
        c.type === 'tool_result' ? [{ kind: 'tool_result', ok: !c.is_error, preview: preview(c.content) }] : [],
      );
    case 'result':
      return [{
        kind: 'done',
        ok: m.subtype === 'success' && !m.is_error,
        summary: typeof m.result === 'string' ? m.result : m.subtype,
        costUsd: m.total_cost_usd,
        turns: m.num_turns,
        durationMs: m.duration_ms,
      }];
    default:
      return [];
  }
}

export const claude: AgentAdapter = {
  name: 'claude',

  detect: () => versionOf('claude'),

  command(o) {
    const args = [
      '-p', o.task,
      '--output-format', 'stream-json',
      '--verbose',
      // acceptEdits: file edits allowed, anything else unapproved is denied in print mode.
      '--permission-mode', o.yolo ? 'bypassPermissions' : 'acceptEdits',
    ];
    if (o.model) args.push('--model', o.model);
    return { cmd: 'claude', args }; // claude is a native .exe: spawns without a shell
  },

  // Claude's stream-json is one complete message per line: no buffering needed.
  parser: () => ({ line: parseLine, end: () => [] }),
};
