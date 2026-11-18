// The normalized event stream every agent adapter produces.
// Adding an agent = writing one adapter that maps its output onto these.
export type AgentEvent =
  | { kind: 'start'; sessionId?: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'tool_result'; ok: boolean; preview: string }
  | { kind: 'done'; ok: boolean; summary: string; costUsd?: number; turns?: number; durationMs?: number }
  | { kind: 'log'; text: string };

export interface RunOptions {
  task: string;
  cwd: string;
  yolo: boolean;
  model?: string;
}

/** Stateful per-run parser: some agents stream text in fragments that must be buffered. */
export interface LineParser {
  line(line: string): AgentEvent[];
  /** Called once when stdout closes, to flush anything buffered. */
  end(): AgentEvent[];
}

export interface AgentAdapter {
  name: string;
  /** Returns the installed version, or null if the agent isn't installed. */
  detect(): string | null;
  /** A warning if the agent is installed but can't run yet (e.g. not signed in). */
  setupHint?(): string | null;
  /** The headless command line for one task. Arguments are passed without a shell. */
  command(o: RunOptions): { cmd: string; args: string[] };
  /** A fresh parser for one run. Never share one between runs. */
  parser(): LineParser;
}
