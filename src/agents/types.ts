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

export interface AgentAdapter {
  name: string;
  /** Returns the installed version, or null if the agent isn't installed. */
  detect(): string | null;
  /** The headless command line for one task. */
  command(o: RunOptions): { cmd: string; args: string[] };
  /** Map one line of the agent's stdout to zero or more events. */
  parse(line: string): AgentEvent[];
}
