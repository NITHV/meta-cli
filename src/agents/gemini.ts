import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent, LineParser } from './types.ts';
import { npmCommand, oneLine, toolDetail, versionOf } from './util.ts';

// Gemini CLI headless mode: `gemini -p <task> -o stream-json`. Event schema (from the
// CLI's JsonStreamEventType): init, message (assistant text arrives as deltas),
// tool_use, tool_result, error, result.

function parser(): LineParser {
  let buf = ''; // assistant text deltas, flushed as one text event
  let last = ''; // last flushed assistant message, used as the run summary

  const flush = (): AgentEvent[] => {
    if (!buf.trim()) return (buf = ''), [];
    last = buf.trim();
    buf = '';
    return [{ kind: 'text', text: last }];
  };

  return {
    line(line) {
      if (!line.trim()) return [];
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        return [...flush(), { kind: 'log', text: line }];
      }
      switch (m.type) {
        case 'init':
          return [{ kind: 'start', sessionId: m.session_id, model: m.model }];
        case 'message':
          if (m.role === 'assistant' && typeof m.content === 'string') {
            if (m.delta) {
              buf += m.content;
            } else {
              const prev = flush();
              buf = m.content;
              return [...prev, ...flush()];
            }
          }
          return [];
        case 'tool_use':
          return [...flush(), { kind: 'tool', name: m.tool_name, detail: toolDetail(m.parameters) }];
        case 'tool_result':
          return [...flush(), {
            kind: 'tool_result',
            ok: m.status === 'success',
            preview: oneLine(String(m.error?.message ?? m.output ?? '')),
          }];
        case 'error':
          return [...flush(), { kind: 'log', text: `${m.severity ?? 'error'}: ${m.message}` }];
        case 'result': {
          const out = flush();
          const ok = m.status === 'success';
          return [...out, {
            kind: 'done',
            ok,
            summary: ok ? last : String(m.error?.message ?? 'failed'),
            durationMs: m.stats?.duration_ms,
          }];
        }
        default:
          return [];
      }
    },
    end: flush,
  };
}

const SAFE_MODEL = /^[\w.:-]+$/;

export const gemini: AgentAdapter = {
  name: 'gemini',

  detect: () => versionOf('gemini'),

  setupHint() {
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_GENAI_USE_GCA) return null;
    const dir = join(homedir(), '.gemini');
    if (existsSync(join(dir, 'oauth_creds.json'))) return null;
    try {
      const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
      if (s?.security?.auth?.selectedType) return null;
    } catch { /* no settings yet */ }
    return 'not signed in: run `gemini` once and log in with Google (free tier)';
  },

  command(o) {
    if (o.model && !SAFE_MODEL.test(o.model)) throw new Error(`invalid model name "${o.model}"`);
    const { cmd, prefix } = npmCommand('gemini', '@google/gemini-cli');
    const args = [
      ...prefix,
      '-p', o.task,
      '-o', 'stream-json',
      '--skip-trust', // the worktree is fresh, so the folder-trust prompt would block headless runs
      '--approval-mode', o.yolo ? 'yolo' : 'auto_edit',
    ];
    if (o.model) args.push('-m', o.model);
    return { cmd, args };
  },

  parser,
};
