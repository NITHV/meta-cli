import { parseArgs } from 'node:util';
import { adapters, getAdapter } from './agents/index.ts';
import { openStore } from './store.ts';
import * as git from './git.ts';
import { execute } from './runner.ts';
import { ago, bold, dim, green, printEvent, red } from './fmt.ts';

const HELP = `meta: run coding agents in isolated git worktrees

Usage:
  meta agents                      List supported agents and whether they're installed
  meta run "<task>" [-a claude]    Run an agent on a task in a fresh worktree
  meta runs                        List runs in this repo
  meta show <run>                  Replay a run's events
  meta diff <run>                  Show the changes a run made
  meta apply <run>                 Squash a run's changes into your working tree (staged)
  meta discard <run>               Delete a run's worktree and branch

Options:
  -a, --agent <name>   Agent to use (default: claude)
  -m, --model <name>   Model to pass to the agent
      --yolo           Let the agent run any tool without asking (bypass permissions)
      --json           Print events as NDJSON
  -h, --help           Show this help

<run> is a run id or a unique prefix of one.
`;

type Opts = { agent: string; model?: string; yolo: boolean; json: boolean };

function newId(): string {
  return Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 4);
}

function cmdAgents(): number {
  for (const a of adapters) {
    const v = a.detect();
    console.log(`${bold(a.name.padEnd(10))} ${v ? green('installed') + dim(' ' + v) : red('not found')}`);
  }
  return 0;
}

async function cmdRun(task: string, o: Opts): Promise<number> {
  if (!task) throw new Error('usage: meta run "<task>"');
  const adapter = getAdapter(o.agent);
  if (!adapter.detect()) throw new Error(`${adapter.name} is not installed or not on PATH`);

  const root = git.root(process.cwd());
  const base = git.head(root);
  if (git.isDirty(root)) console.error(dim('note: uncommitted changes are not visible to the agent (it starts from HEAD)'));
  git.excludeMeta(root);

  const store = openStore(root);
  const id = newId();
  const { path, branch } = git.addWorktree(root, id, base);
  store.createRun({ id, agent: adapter.name, task, base, branch, worktree: path });
  if (!o.json) console.log(dim(`run ${id} · ${adapter.name} · worktree .meta/worktrees/${id}`));

  const result = await execute(adapter, { task, cwd: path, yolo: o.yolo, model: o.model }, (ev) => {
    store.addEvent(id, ev);
    printEvent(ev, o.json);
  });

  git.commitAll(path, `meta ${id}: ${task}`);
  const files = git.changedFiles(root, base, branch); // also catches commits the agent made itself
  const status = result.cancelled ? 'cancelled' : result.ok ? 'done' : 'failed';
  store.finishRun(id, {
    status,
    exitCode: result.exitCode,
    summary: result.done?.summary,
    costUsd: result.done?.costUsd,
    turns: result.done?.turns,
    filesChanged: files.length,
  });

  if (!o.json) {
    console.log();
    if (files.length) {
      console.log(`${bold(String(files.length))} file(s) changed:`);
      for (const f of files) console.log(`  ${f}`);
      console.log(dim(`\nreview: meta diff ${id}   apply: meta apply ${id}   drop: meta discard ${id}`));
    } else {
      console.log(dim(`no file changes. clean up with: meta discard ${id}`));
    }
  }
  return result.ok ? 0 : 1;
}

function cmdRuns(): number {
  const store = openStore(git.root(process.cwd()));
  const runs = store.listRuns();
  if (!runs.length) {
    console.log(dim('no runs yet. try: meta run "<task>"'));
    return 0;
  }
  for (const r of runs) {
    const color = r.status === 'failed' ? red : r.status === 'done' || r.status === 'applied' ? green : dim;
    const task = r.task.length > 50 ? r.task.slice(0, 47) + '...' : r.task;
    console.log(
      `${bold(r.id)}  ${color(r.status.padEnd(9))} ${r.agent.padEnd(8)} ${dim(ago(r.started_at).padEnd(8))} ` +
        `${String(r.files_changed ?? '-').padStart(3)} files  ${task}`,
    );
  }
  return 0;
}

function cmdShow(ref: string, o: Opts): number {
  const store = openStore(git.root(process.cwd()));
  const run = store.findRun(ref);
  if (!o.json) console.log(dim(`run ${run.id} · ${run.agent} · ${run.status} · ${run.task}`));
  for (const ev of store.events(run.id)) printEvent(ev, o.json);
  return 0;
}

function cmdDiff(ref: string): number {
  const root = git.root(process.cwd());
  const run = openStore(root).findRun(ref);
  return git.showDiff(root, run.base, run.branch);
}

function cmdApply(ref: string): number {
  const root = git.root(process.cwd());
  const store = openStore(root);
  const run = store.findRun(ref);
  if (run.status === 'applied' || run.status === 'discarded') throw new Error(`run ${run.id} is already ${run.status}`);
  if (run.status === 'running') throw new Error(`run ${run.id} is still running`);
  const code = git.squashInto(root, run.branch);
  if (code !== 0) throw new Error('merge failed; resolve conflicts, then run `meta discard` when done');
  git.remove(root, run.worktree, run.branch);
  store.setStatus(run.id, 'applied');
  console.log(green(`applied ${run.id}. changes are staged; review with \`git diff --cached\` and commit.`));
  return 0;
}

function cmdDiscard(ref: string): number {
  const root = git.root(process.cwd());
  const store = openStore(root);
  const run = store.findRun(ref);
  git.remove(root, run.worktree, run.branch);
  if (run.status !== 'applied') store.setStatus(run.id, 'discarded');
  console.log(dim(`discarded ${run.id}`));
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string', short: 'a', default: 'claude' },
      model: { type: 'string', short: 'm' },
      yolo: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const o = values as Opts & { help: boolean };
  const [cmd, ...rest] = positionals;
  if (!cmd || o.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const needRef = () => {
    if (!rest[0]) throw new Error(`usage: meta ${cmd} <run>`);
    return rest[0];
  };
  switch (cmd) {
    case 'agents': return cmdAgents();
    case 'run': return cmdRun(rest.join(' '), o);
    case 'runs': return cmdRuns();
    case 'show': return cmdShow(needRef(), o);
    case 'diff': return cmdDiff(needRef());
    case 'apply': return cmdApply(needRef());
    case 'discard': return cmdDiscard(needRef());
    default: throw new Error(`unknown command "${cmd}". See: meta --help`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(`error: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  },
);
