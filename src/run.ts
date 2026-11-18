import { getAdapter } from './agents/index.ts';
import type { AgentAdapter, AgentEvent } from './agents/types.ts';
import type { RunStatus, Store } from './store.ts';
import * as git from './git.ts';
import { execute } from './runner.ts';

export interface RunSpec {
  adapter: AgentAdapter;
  model?: string;
}

export interface RunOutcome {
  id: string;
  spec: RunSpec;
  status: RunStatus;
  files: string[];
  shortstat: string;
  turns?: number;
  durationMs: number;
  error?: string;
}

export function newId(): string {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
}

/** Parse "claude", "claude:haiku" or "claude:haiku,claude:sonnet" into run specs. */
export function parseSpecs(list: string, defaultModel?: string): RunSpec[] {
  const specs = list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, model] = s.split(':');
    return { adapter: getAdapter(name), model: model || defaultModel };
  });
  for (const name of new Set(specs.map((s) => s.adapter.name))) {
    if (!getAdapter(name).detect()) throw new Error(`${name} is not installed or not on PATH`);
  }
  return specs;
}

export function label(spec: RunSpec): string {
  return spec.adapter.name + (spec.model ? ':' + spec.model : '');
}

/** One agent, one task, one worktree. Everything is recorded in the store. */
export async function runOne(
  ctx: { root: string; base: string; store: Store },
  spec: RunSpec,
  task: string,
  opts: { yolo: boolean; raceId?: string },
  hooks: { onStart?: (id: string) => void; onEvent: (id: string, ev: AgentEvent) => void },
): Promise<RunOutcome> {
  const { root, base, store } = ctx;
  const id = newId();
  const t0 = Date.now();
  const { path, branch } = git.addWorktree(root, id, base);
  store.createRun({
    id, agent: spec.adapter.name, model: spec.model ?? null, race_id: opts.raceId ?? null,
    task, base, branch, worktree: path,
  });
  hooks.onStart?.(id);

  const result = await execute(spec.adapter, { task, cwd: path, yolo: opts.yolo, model: spec.model }, (ev) => {
    store.addEvent(id, ev);
    hooks.onEvent(id, ev);
  });

  git.commitAll(path, `meta ${id}: ${task}`);
  const files = git.changedFiles(root, base, branch); // also catches commits the agent made itself
  const status: RunStatus = result.cancelled ? 'cancelled' : result.ok ? 'done' : 'failed';
  store.finishRun(id, {
    status,
    exitCode: result.exitCode,
    summary: result.done?.summary,
    costUsd: result.done?.costUsd,
    turns: result.done?.turns,
    filesChanged: files.length,
  });
  return {
    id, spec, status, files,
    shortstat: git.shortstat(root, base, branch),
    turns: result.done?.turns,
    durationMs: Date.now() - t0,
  };
}

/** Run tasks with at most `max` in flight: a cap on concurrent agents (RAM is the limit). */
export async function pool<T>(tasks: (() => Promise<T>)[], max: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(max, tasks.length) }, worker));
  return out;
}
