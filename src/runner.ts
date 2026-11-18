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
  const { cmd, args } = a.command(opts);
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  let done: RunResult['done'];
  let cancelled = false;
  let stderr = '';

  // Show paths relative to the worktree instead of long absolute ones.
  const prefixes = [opts.cwd.replace(/\//g, '\\'), opts.cwd.replace(/\\/g, '/')].map((p) => p.replace(/[\\/]?$/, ''));
  const relativize = (s: string) => prefixes.reduce((acc, p) => acc.split(p + '\\').join('').split(p + '/').join(''), s);

  createInterface({ input: child.stdout }).on('line', (line) => {
    for (let ev of a.parse(line)) {
      if (ev.kind === 'tool') ev = { ...ev, detail: relativize(ev.detail) };
      if (ev.kind === 'done') done = ev;
      onEvent(ev);
    }
  });
  child.stderr.on('data', (d) => (stderr += d));

  const onSigint = () => {
    cancelled = true;
    child.kill();
  };
  process.on('SIGINT', onSigint);

  return new Promise((resolve) => {
    child.on('error', (err) => {
      process.off('SIGINT', onSigint);
      onEvent({ kind: 'log', text: `failed to start ${cmd}: ${err.message}` });
      resolve({ ok: false, exitCode: -1, cancelled });
    });
    child.on('close', (code) => {
      process.off('SIGINT', onSigint);
      if (stderr.trim() && (!done || !done.ok)) onEvent({ kind: 'log', text: stderr.trim() });
      const exitCode = code ?? -1;
      resolve({ ok: !cancelled && exitCode === 0 && (done?.ok ?? false), exitCode, cancelled, done });
    });
  });
}
