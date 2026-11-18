import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentAdapter, AgentEvent, RunOptions } from './agents/types.ts';

export interface RunResult {
  ok: boolean;
  exitCode: number;
  cancelled: boolean;
  done?: Extract<AgentEvent, { kind: 'done' }>;
}

/** Spawn the agent headlessly and turn its stdout into normalized events. */
export function execute(a: AgentAdapter, opts: RunOptions, onEvent: (ev: AgentEvent) => void): Promise<RunResult> {
  let command: { cmd: string; args: string[] };
  try {
    command = a.command(opts);
  } catch (err) {
    onEvent({ kind: 'log', text: `error: ${err instanceof Error ? err.message : String(err)}` });
    return Promise.resolve({ ok: false, exitCode: -1, cancelled: false });
  }
  const child = spawn(command.cmd, command.args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const parser = a.parser(); // one per run: parsers may buffer state

  let done: RunResult['done'];
  let cancelled = false;
  let stderr = '';

  // Show paths relative to the worktree instead of long absolute ones.
  const prefixes = [opts.cwd.replace(/\//g, '\\'), opts.cwd.replace(/\\/g, '/')].map((p) => p.replace(/[\\/]?$/, ''));
  const relativize = (s: string) => prefixes.includes(s.replace(/[\\/]$/, '')) ? '.' : prefixes.reduce((acc, p) => acc.split(p + '\\').join('').split(p + '/').join(''), s);

  const emit = (events: AgentEvent[]) => {
    for (let ev of events) {
      if (ev.kind === 'tool') ev = { ...ev, detail: relativize(ev.detail) };
      if (ev.kind === 'done') done = ev;
      onEvent(ev);
    }
  };

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => emit(parser.line(line)));
  const stdoutClosed = new Promise<void>((r) => rl.on('close', () => r()));
  child.stderr.on('data', (d) => (stderr += d));

  const onSigint = () => {
    cancelled = true;
    child.kill();
  };
  process.on('SIGINT', onSigint);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.off('SIGINT', onSigint);
      onEvent({ kind: 'log', text: `failed to start ${command.cmd}: ${err.message}` });
      resolve({ ok: false, exitCode: -1, cancelled });
    });
    child.on('close', async (code) => {
      process.off('SIGINT', onSigint);
      await stdoutClosed;
      emit(parser.end());
      if (stderr.trim() && (!done || !done.ok)) onEvent({ kind: 'log', text: stderr.trim() });
      const exitCode = code ?? -1;
      resolve({ ok: !cancelled && exitCode === 0 && (done?.ok ?? false), exitCode, cancelled, done });
    });
  });
}
