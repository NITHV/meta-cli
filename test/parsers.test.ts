import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gemini } from '../src/agents/gemini.ts';
import { claude } from '../src/agents/claude.ts';
import { agy } from '../src/agents/agy.ts';
import type { AgentEvent } from '../src/agents/types.ts';

function feed(lines: object[], p = gemini.parser()): AgentEvent[] {
  return [...lines.flatMap((l) => p.line(JSON.stringify(l))), ...p.end()];
}

test('gemini: buffers assistant deltas into one text event', () => {
  const ev = feed([
    { type: 'init', session_id: 's1', model: 'gemini-2.5-flash' },
    { type: 'message', role: 'user', content: 'fix it' },
    { type: 'message', role: 'assistant', content: 'Looking ', delta: true },
    { type: 'message', role: 'assistant', content: 'at add.js', delta: true },
    { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { absolute_path: 'add.js' } },
    { type: 'tool_result', tool_id: 't1', status: 'success', output: 'function add' },
    { type: 'message', role: 'assistant', content: 'Fixed.', delta: true },
    { type: 'result', status: 'success', stats: { duration_ms: 1200, tool_calls: 1 } },
  ]);
  assert.deepEqual(ev, [
    { kind: 'start', sessionId: 's1', model: 'gemini-2.5-flash' },
    { kind: 'text', text: 'Looking at add.js' },
    { kind: 'tool', name: 'read_file', detail: 'add.js' },
    { kind: 'tool_result', ok: true, preview: 'function add' },
    { kind: 'text', text: 'Fixed.' },
    { kind: 'done', ok: true, summary: 'Fixed.', durationMs: 1200 },
  ]);
});

test('gemini: error result and tool failure', () => {
  const ev = feed([
    { type: 'tool_result', tool_id: 't1', status: 'error', error: { type: 'X', message: 'denied' } },
    { type: 'error', severity: 'warning', message: 'loop detected' },
    { type: 'result', status: 'error', error: { type: 'Fatal', message: 'quota exceeded' }, stats: {} },
  ]);
  assert.deepEqual(ev, [
    { kind: 'tool_result', ok: false, preview: 'denied' },
    { kind: 'log', text: 'warning: loop detected' },
    { kind: 'done', ok: false, summary: 'quota exceeded', durationMs: undefined },
  ]);
});

test('gemini: flushes trailing text on end', () => {
  assert.deepEqual(feed([{ type: 'message', role: 'assistant', content: 'partial', delta: true }]), [
    { kind: 'text', text: 'partial' },
  ]);
});

test('parsers are independent per run', () => {
  const a = gemini.parser();
  const b = gemini.parser();
  a.line(JSON.stringify({ type: 'message', role: 'assistant', content: 'A', delta: true }));
  b.line(JSON.stringify({ type: 'message', role: 'assistant', content: 'B', delta: true }));
  assert.deepEqual(a.end(), [{ kind: 'text', text: 'A' }]);
  assert.deepEqual(b.end(), [{ kind: 'text', text: 'B' }]);
});

test('gemini: rejects unsafe model names', () => {
  assert.throws(() => gemini.command({ task: 't', cwd: '.', yolo: false, model: 'x & calc' }), /invalid model/);
});

// Shapes follow the examples in antigravity.google/docs/cli/headless.
const step = (s: object) => ({ event: 'step_update', step_update: { conversation_id: 'c1', ...s } });

test('agy: init, streamed text, tool call and result', () => {
  const ev = feed([
    { event: 'init', conversation_id: 'c1', init: { cwd: '.', tools: [], permission_mode: 'request-review' } },
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Running ' }),
    step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'echo\n' }),
    step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } } }),
    step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\r\n' } }),
    { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Done.', duration_seconds: 2.5, num_turns: 3 } },
  ], agy.parser());
  assert.deepEqual(ev, [
    { kind: 'start', sessionId: 'c1', model: undefined },
    { kind: 'text', text: 'Running echo' },
    { kind: 'tool', name: 'run_command', detail: 'echo hi' },
    { kind: 'tool_result', ok: true, preview: 'hi' },
    { kind: 'done', ok: true, summary: 'Done.', turns: 3, durationMs: 2500 },
  ]);
});

test('agy: tool step reported only as DONE still yields call + result', () => {
  const ev = feed([
    step({ step_index: 4, state: 'DONE', step_type: 'tool',
      tool_info: { name: 'write_to_file', parameters: { TargetFile: 'add.js' }, error: { type: 'X', message: 'denied' } } }),
  ], agy.parser());
  assert.deepEqual(ev, [
    { kind: 'tool', name: 'write_to_file', detail: 'add.js' },
    { kind: 'tool_result', ok: false, preview: 'denied' },
  ]);
});

test('agy: failed result', () => {
  const ev = feed([{ event: 'result', result: { status: 'INTERRUPTED', num_turns: 1 } }], agy.parser());
  assert.equal(ev.length, 1);
  assert.equal((ev[0] as any).ok, false);
  assert.equal((ev[0] as any).summary, 'INTERRUPTED');
});

test('agy: uses accept-edits by default and skip-permissions with yolo', () => {
  if (!agy.detect()) return; // command() needs the binary; parser tests above cover the rest
  assert.ok(agy.command({ task: 't', cwd: '.', yolo: false }).args.includes('--mode=accept-edits'));
  assert.ok(agy.command({ task: 't', cwd: '.', yolo: true }).args.includes('--dangerously-skip-permissions'));
});

test('claude: maps result line', () => {
  const ev = feed(
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 2, duration_ms: 5 }],
    claude.parser(),
  );
  assert.deepEqual(ev, [{ kind: 'done', ok: true, summary: 'ok', costUsd: undefined, turns: 2, durationMs: 5 }]);
});
