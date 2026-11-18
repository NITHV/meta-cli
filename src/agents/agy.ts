import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent, LineParser } from './types.ts';
import { oneLine, toolDetail } from './util.ts';

// Antigravity CLI (`agy`), Google's replacement for Gemini CLI.
// Headless: `agy -p <task> --output-format stream-json`. Documented NDJSON events
// (antigravity.google/docs/cli/headless): init, step_update, result, keyed by `event`,
// with the payload under a field of the same name.
//   step_update.step_type: user_input | agent_response | tool | checkpoint
//   agent_response streams `text_delta`; tool steps carry tool_info {name, parameters, output, error?}
// Not yet verified against a live run: the exact success `status` value, and whether
// tool steps also emit ACTIVE updates. Both are handled defensively below.

const FAILED_STATUS = new Set(['CANCELED', 'CANCELLED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING', 'ERROR', 'FAILED', 'FAILURE']);
// Seen live: a denied or failed tool step ends in state ERROR rather than DONE.
const isTerminal = (state: unknown) => typeof state === 'string' && state !== 'ACTIVE';

function parser(): LineParser {
  let buf = '';
  const toolsSeen = new Set<number>(); // step_index of tool calls already announced
  const resultsSeen = new Set<number>();

  const flush = (): AgentEvent[] => {
    const t = buf.trim();
    buf = '';
    return t ? [{ kind: 'text', text: t }] : [];
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
      const p = (m.event && m[m.event]) || m; // payload lives under the event's own name
      switch (m.event) {
        case 'init':
          return [{ kind: 'start', sessionId: m.conversation_id ?? p.conversation_id, model: p.model }];

        case 'step_update': {
          if (p.step_type === 'agent_response') {
            if (typeof p.text_delta === 'string') buf += p.text_delta;
            return isTerminal(p.state) ? flush() : [];
          }
          if (p.step_type === 'error_message') {
            // Seen live on successful runs with no payload: only surface ones that say something.
            const msg = String(p.error?.message ?? p.text_delta ?? '').trim();
            return msg ? [...flush(), { kind: 'log', text: `agy: ${msg}` }] : [];
          }
          if (p.step_type === 'tool') {
            const out: AgentEvent[] = [...flush()];
            const i = Number(p.step_index);
            const info = p.tool_info ?? {};
            if (!toolsSeen.has(i)) {
              toolsSeen.add(i);
              out.push({ kind: 'tool', name: info.name ?? p.tool_name ?? 'tool', detail: toolDetail(info.parameters) });
            }
            if (isTerminal(p.state) && !resultsSeen.has(i)) {
              resultsSeen.add(i);
              out.push({
                kind: 'tool_result',
                ok: p.state === 'DONE' && !info.error,
                preview: oneLine(String(info.error?.message ?? info.output ?? '')),
              });
            }
            return out;
          }
          return [];
        }

        case 'result': {
          const out = flush();
          if (Array.isArray(p.denied_actions) && p.denied_actions.length) {
            const names = p.denied_actions.map((d: any) => d?.display_name ?? d?.action ?? '?').join(', ');
            out.push({ kind: 'log', text: `agy denied: ${names} (use --yolo to allow)` });
          }
          const status = String(p.status ?? '').toUpperCase();
          // Seen live: a denial ends the headless turn with status SUCCESS but no response.
          const stoppedByDenial = Array.isArray(p.denied_actions) && p.denied_actions.length > 0 && !String(p.response ?? '').trim();
          if (stoppedByDenial && !p.error) {
            return [...out, { kind: 'done', ok: false, summary: 'stopped: a tool call was denied', turns: p.num_turns,
              durationMs: typeof p.duration_seconds === 'number' ? Math.round(p.duration_seconds * 1000) : undefined }];
          }
          const ok = !p.error && !FAILED_STATUS.has(status) && p.finished_reason !== 'error';
          return [...out, {
            kind: 'done',
            ok,
            summary: ok ? String(p.response ?? '') : String(p.error?.message ?? p.error ?? (status || 'failed')),
            turns: p.num_turns,
            durationMs: typeof p.duration_seconds === 'number' ? Math.round(p.duration_seconds * 1000) : undefined,
          }];
        }

        default:
          return [];
      }
    },
    end: flush,
  };
}

/** agy is a native Go binary: on PATH, or in the installer's default location. */
function resolveAgy(): string | null {
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agy'], { encoding: 'utf8' });
  const first = onPath.status === 0 ? onPath.stdout.split(/\r?\n/).find(Boolean) : undefined;
  if (first) return first.trim();
  const local = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe') : '';
  return local && existsSync(local) ? local : null;
}

const SAFE_MODEL = /^[\w.:-]+$/;

export const agy: AgentAdapter = {
  name: 'agy',

  detect() {
    const bin = resolveAgy();
    if (!bin) return null;
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim().split('\n')[0] || 'installed' : 'installed';
  },

  command(o) {
    const bin = resolveAgy();
    if (!bin) throw new Error('agy is not installed');
    if (o.model && !SAFE_MODEL.test(o.model)) throw new Error(`invalid model name "${o.model}"`);
    // In headless accept-edits mode, agy ends the whole run at the first denied shell
    // command (seen live, even with --sandbox). Tell it up front to stick to file tools.
    const task = o.yolo
      ? o.task
      : `${o.task}\n\n(Note: shell commands are not available in this session and will be denied. ` +
        `Use only your file reading, searching and editing tools.)`;
    const args = [
      '-p', task,
      '--output-format', 'stream-json',
      // accept-edits: file edits allowed; other permission requests are soft-denied in headless mode.
      o.yolo ? '--dangerously-skip-permissions' : '--mode=accept-edits',
    ];
    if (o.model) args.push('--model', o.model);
    return { cmd: bin, args }; // native exe: no shell, task text passed verbatim
  },

  parser,
};
