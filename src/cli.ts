import { parseArgs, styleText } from 'node:util';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from './agents/index.ts';
import type { AgentEvent } from './agents/types.ts';
import { openStore } from './store.ts';
import * as git from './git.ts';
import { applyRun, discardRun, label, newId, parseSpecs, pool, runOne, type RunOutcome } from './run.ts';
import { serve } from './server.ts';
import { ago, bold, dim, green, printEvent, red } from './fmt.ts';

const HELP = `meta: run coding agents in isolated git worktrees

Usage:
  meta agents                        List supported agents and whether they're installed
  meta run "<task>" [-a claude]      Run an agent on a task in a fresh worktree
  meta race "<task>" -a x -a y       Run several agents on the same task in parallel, then compare
  meta runs                          List runs in this repo
  meta show <run>                    Replay a run's events
  meta diff <run>                    Show the changes a run made
  meta apply <run>                   Squash a run's changes into your working tree (staged)
  meta discard <run>                 Delete a run's worktree and branch
  meta stats                         Success and keep rate per agent
  meta ide [folder]                  Open the desktop IDE (Claude tabs, files, Markdown reader)
  meta serve                         Open the older web IDE for this repo

Options:
  -a, --agent <name>   Agent (default: claude). Repeat for race: -a claude:haiku -a claude:sonnet
                       agent:model picks a model. A comma list works too, but quote it in PowerShell.
  -m, --model <name>   Default model for agents without one
      --max <n>        Race: max agents running at once (default: 2)
      --yolo           Let agents run any tool without asking (bypass permissions)
      --json           Print events as NDJSON
      --port <n>       serve: port (default 4321)
      --lan            serve: also listen on your Wi-Fi so a phone can connect
      --no-open        serve: don't open the browser
  -h, --help           Show this help

<run> is a run id or a unique prefix of one.
`;

type Opts = { agent: string; model?: string; max: string; yolo: boolean; json: boolean };

function context() {
  const root = git.root(process.cwd());
  const base = git.head(root);
  if (git.isDirty(root)) console.error(dim('note: uncommitted changes are not visible to agents (they start from HEAD)'));
  git.excludeMeta(root);
  return { root, base, store: openStore(root) };
}

function cmdAgents(): number {
  for (const a of adapters) {
    const v = a.detect();
    const hint = v ? a.setupHint?.() : null;
    const state = !v ? red('not found') : hint ? styleText('yellow', 'needs setup') : green('ready');
    console.log(`${bold(a.name.padEnd(10))} ${state}${v ? dim(' ' + v) : ''}${hint ? '\n' + ' '.repeat(11) + dim(hint) : ''}`);
  }
  return 0;
}

async function cmdRun(task: string, o: Opts): Promise<number> {
  if (!task) throw new Error('usage: meta run "<task>"');
  const specs = parseSpecs(o.agent, o.model);
  if (specs.length !== 1) throw new Error('run takes one agent; use `meta race` for several');
  const ctx = context();

  const out = await runOne(ctx, specs[0], task, { yolo: o.yolo }, {
    onStart: (id) => { if (!o.json) console.log(dim(`run ${id} · ${label(specs[0])} · worktree .meta/worktrees/${id}`)); },
    onEvent: (_id, ev) => printEvent(ev, o.json),
  });

  if (!o.json) {
    console.log();
    if (out.files.length) {
      console.log(`${bold(String(out.files.length))} file(s) changed:`);
      for (const f of out.files) console.log(`  ${f}`);
      console.log(dim(`\nreview: meta diff ${out.id}   apply: meta apply ${out.id}   drop: meta discard ${out.id}`));
    } else {
      console.log(dim(`no file changes. clean up with: meta discard ${out.id}`));
    }
  }
  return out.status === 'done' ? 0 : 1;
}

const COLORS = ['cyan', 'magenta', 'yellow', 'blue', 'green'] as const;

async function cmdRace(task: string, o: Opts): Promise<number> {
  if (!task) throw new Error('usage: meta race "<task>" -a claude:haiku,claude:sonnet');
  const specs = parseSpecs(o.agent, o.model);
  if (specs.length < 2) throw new Error('race needs at least two agents, e.g. -a claude:haiku,claude:sonnet');
  const max = Math.max(1, Number.parseInt(o.max, 10) || 2);
  const ctx = context();
  const raceId = newId();

  // Unique, colored tag per contestant so interleaved output stays readable.
  const tags = specs.map((s, i) => {
    const dup = specs.filter((x) => label(x) === label(s)).length > 1;
    return styleText(COLORS[i % COLORS.length], `[${label(s)}${dup ? '#' + (i + 1) : ''}]`);
  });

  if (!o.json) console.log(dim(`race ${raceId} · ${specs.length} agents · max ${max} at once`));

  const tasks = specs.map((spec, i) => async (): Promise<RunOutcome | null> => {
    try {
      return await runOne(ctx, spec, task, { yolo: o.yolo, raceId }, {
        onStart: (id) => { if (!o.json) console.log(`${tags[i]} ${dim('started run ' + id)}`); },
        onEvent: (id, ev) => {
          if (o.json) return void process.stdout.write(JSON.stringify({ run: id, ...ev }) + '\n');
          printRaceEvent(tags[i], ev);
        },
      });
    } catch (err) {
      console.error(`${tags[i]} ${red('error: ' + (err instanceof Error ? err.message : String(err)))}`);
      return null;
    }
  });
  const results = await pool(tasks, max);

  if (!o.json) {
    console.log('\n' + bold('results'));
    results.forEach((r, i) => {
      if (!r) return void console.log(`  ${tags[i]} ${red('did not run')}`);
      const st = (r.status === 'done' ? green : red)(r.status.padEnd(9)); // pad before coloring
      const t = `${(r.durationMs / 1000).toFixed(1)}s`;
      console.log(`  ${bold(r.id)} ${tags[i]} ${st} ${t.padStart(7)}  ${r.turns ?? '-'} turns  ${r.shortstat || dim('no changes')}`);
    });
    console.log(dim('\ncompare: meta diff <id>   keep one: meta apply <id>   drop the rest: meta discard <id>'));
  }
  return results.some((r) => r?.status === 'done') ? 0 : 1;
}

/** Race output is compact: progress lines only. Full text is in `meta show`. */
function printRaceEvent(tag: string, ev: AgentEvent): void {
  switch (ev.kind) {
    case 'tool': {
      const d = ev.detail.length > 80 ? ev.detail.slice(0, 77) + '...' : ev.detail;
      console.log(`${tag} ${dim(`→ ${ev.name} ${d}`)}`);
      break;
    }
    case 'tool_result':
      if (!ev.ok) console.log(`${tag} ${red('✗ ' + ev.preview.slice(0, 80))}`);
      break;
    case 'done':
      console.log(`${tag} ${ev.ok ? green('finished') : red('failed')}`);
      break;
    case 'log':
      console.log(`${tag} ${dim(ev.text)}`);
      break;
  }
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
    const task = r.task.length > 44 ? r.task.slice(0, 41) + '...' : r.task;
    const who = (r.agent + (r.model ? ':' + r.model : '')).padEnd(14);
    const race = r.race_id ? dim(' race ' + r.race_id) : '';
    console.log(
      `${bold(r.id)}  ${color(r.status.padEnd(9))} ${who} ${dim(ago(r.started_at).padEnd(8))} ` +
        `${String(r.files_changed ?? '-').padStart(3)} files  ${task}${race}`,
    );
  }
  return 0;
}

function cmdStats(): number {
  const rows = openStore(git.root(process.cwd())).stats();
  if (!rows.length) {
    console.log(dim('no finished runs yet'));
    return 0;
  }
  const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
  const w = Math.max(5, ...rows.map((r) => r.who.length)) + 1;
  console.log(dim(`${'agent'.padEnd(w)} ${'runs'.padStart(4)} ${'success'.padStart(8)} ${'kept'.padStart(6)} ${'turns'.padStart(6)} ${'avg time'.padStart(9)}`));
  for (const r of rows) {
    console.log(
      `${bold(r.who.padEnd(w))} ${String(r.runs).padStart(4)} ${pct(r.ok, r.runs).padStart(8)} ` +
        `${pct(r.applied, r.runs).padStart(6)} ${(r.avg_turns?.toFixed(1) ?? '-').padStart(6)} ` +
        `${(r.avg_ms != null ? (r.avg_ms / 1000).toFixed(1) + 's' : '-').padStart(9)}`,
    );
  }
  console.log(dim('\nsuccess = agent finished its task; kept = you applied its work'));
  return 0;
}

function cmdShow(ref: string, o: Opts): number {
  const store = openStore(git.root(process.cwd()));
  const run = store.findRun(ref);
  if (!o.json) console.log(dim(`run ${run.id} · ${run.agent}${run.model ? ':' + run.model : ''} · ${run.status} · ${run.task}`));
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
  const rivals = applyRun(root, store, run);
  console.log(green(`applied ${run.id}. changes are staged; review with \`git diff --cached\` and commit.`));
  if (rivals.length) console.log(dim(`other runs in this race: ${rivals.map((r) => r.id).join(' ')} (meta discard <id>)`));
  return 0;
}

function cmdDiscard(ref: string): number {
  const root = git.root(process.cwd());
  const store = openStore(root);
  const run = store.findRun(ref);
  discardRun(root, store, run);
  console.log(dim(`discarded ${run.id}`));
  return 0;
}

/** Launch the desktop IDE (app/) on a folder, detached from this terminal. */
function openIde(dir?: string): number {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');
  const exe = join(appDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!existsSync(exe)) throw new Error(`the IDE isn't installed yet: run npm install in ${appDir}`);
  const target = resolve(dir ?? process.cwd());
  if (!existsSync(target)) throw new Error(`no such folder: ${target}`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, [appDir, target], { detached: true, stdio: 'ignore', env }).unref();
  console.log(dim(`opening meta IDE on ${target}`));
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string', short: 'a', multiple: true },
      model: { type: 'string', short: 'm' },
      max: { type: 'string', default: '2' },
      yolo: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      port: { type: 'string', default: '4321' },
      lan: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  // -a may repeat (-a x -a y) or be a quoted comma list; both become one list.
  const agentList = (values.agent as string[] | undefined)?.join(',') || 'claude';
  const o = { ...values, agent: agentList } as Opts & { help: boolean };
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
    case 'race': return cmdRace(rest.join(' '), o);
    case 'runs': return cmdRuns();
    case 'stats': return cmdStats();
    case 'ide': return openIde(rest[0]);
    case 'serve': return serve({
      port: Number.parseInt(values.port as string, 10) || 4321,
      host: values.lan ? '0.0.0.0' : '127.0.0.1',
      open: !values['no-open'],
    });
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
