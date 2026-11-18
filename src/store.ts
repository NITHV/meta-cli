import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from './agents/types.ts';

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'applied' | 'discarded';

export interface RunRow {
  id: string;
  agent: string;
  task: string;
  base: string;
  branch: string;
  worktree: string;
  status: RunStatus;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  summary: string | null;
  cost_usd: number | null;
  turns: number | null;
  files_changed: number | null;
}

// One SQLite file per repo: the single source of truth for runs and their event logs.
export function openStore(root: string) {
  const dir = join(root, '.meta');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'meta.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, task TEXT NOT NULL,
      base TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL,
      status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
      exit_code INTEGER, summary TEXT, cost_usd REAL, turns INTEGER, files_changed INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
      kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, seq)
    );
  `);

  const insRun = db.prepare(
    'INSERT INTO runs (id, agent, task, base, branch, worktree, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insEvent = db.prepare('INSERT INTO events (run_id, seq, ts, kind, data) VALUES (?, ?, ?, ?, ?)');
  const finish = db.prepare(
    `UPDATE runs SET status = ?, ended_at = ?, exit_code = ?, summary = ?, cost_usd = ?, turns = ?, files_changed = ?
     WHERE id = ?`,
  );
  const setStatusStmt = db.prepare('UPDATE runs SET status = ? WHERE id = ?');
  const seqs = new Map<string, number>();

  return {
    createRun(r: Pick<RunRow, 'id' | 'agent' | 'task' | 'base' | 'branch' | 'worktree'>) {
      insRun.run(r.id, r.agent, r.task, r.base, r.branch, r.worktree, 'running', Date.now());
    },

    addEvent(runId: string, ev: AgentEvent) {
      const seq = seqs.get(runId) ?? 0;
      seqs.set(runId, seq + 1);
      insEvent.run(runId, seq, Date.now(), ev.kind, JSON.stringify(ev));
    },

    finishRun(id: string, f: { status: RunStatus; exitCode: number; summary?: string; costUsd?: number; turns?: number; filesChanged: number }) {
      finish.run(f.status, Date.now(), f.exitCode, f.summary ?? null, f.costUsd ?? null, f.turns ?? null, f.filesChanged, id);
    },

    setStatus(id: string, status: RunStatus) {
      setStatusStmt.run(status, id);
    },

    listRuns(): RunRow[] {
      return db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all() as unknown as RunRow[];
    },

    /** Find a run by id or unique id prefix. */
    findRun(prefix: string): RunRow {
      const rows = db.prepare('SELECT * FROM runs WHERE id LIKE ?').all(prefix + '%') as unknown as RunRow[];
      if (rows.length === 0) throw new Error(`no run matching "${prefix}"`);
      if (rows.length > 1) throw new Error(`"${prefix}" matches ${rows.length} runs; use more characters`);
      return rows[0];
    },

    events(runId: string): AgentEvent[] {
      const rows = db.prepare('SELECT data FROM events WHERE run_id = ? ORDER BY seq').all(runId) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data));
    },
  };
}

export type Store = ReturnType<typeof openStore>;
