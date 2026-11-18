# meta-cli

CLI-first orchestrator for coding agents. Each run gets its own git worktree, so
agents never touch your working tree until you `apply`.

```powershell
npm link                     # once, from this folder: puts `meta` on PATH
cd <your repo>
meta agents
meta run "fix the failing test in parser.ts"
meta diff <run>; meta apply <run>   # or: meta discard <run>
meta runs

# same task, several agents in parallel, then keep the best
meta race "add input validation to add()" -a claude:haiku -a claude:sonnet
meta stats                   # success and keep rate per agent:model
```

Requires Node 24+ and git. No dependencies: TypeScript runs directly via Node's
type stripping, and state lives in `.meta/meta.db` (built-in `node:sqlite`).

## Design

- **Adapters** (`src/agents/`): each agent's headless mode is mapped onto one
  normalized event stream (`AgentEvent`). Adding an agent = one file.
- **Isolation**: a run is a worktree at `.meta/worktrees/<id>` on branch
  `meta/<id>`, based on your HEAD. `apply` squash-merges it and leaves the
  changes staged for you to commit.
- **Safety**: by default agents may edit files but shell commands are denied
  (Claude `--permission-mode acceptEdits`, agy `--mode=accept-edits`). `--yolo`
  bypasses permissions; the worktree isolates files, not your machine.
- **agy caveat**: in headless safe mode, agy ends the run at the first denied
  shell command (Claude keeps going). meta tells agy to stick to file tools and
  marks such runs `failed`; use `--yolo` if you want agy to run commands.
  Free-tier Gemini models sometimes return 503 "no capacity": pick another with
  `-a agy:<model>` (list them with `agy models`).
- **State**: every run and event is in SQLite, so `meta show <run>` can replay it.
- **Race**: contestants run through a worker pool capped by `--max` (default 2),
  so a laptop with little RAM isn't swamped. Runs in a race share a `race_id`.

## Roadmap

- [x] `run`, `diff`, `apply`, `discard`, `show`, `runs`
- [x] `race` with a concurrency cap, `stats` per agent:model
- [x] `agy` adapter for Antigravity CLI (Google's Gemini CLI replacement; sign in once with `agy`)
- [x] `gemini` adapter (paid API keys only: retired for free/Pro accounts on 2026-06-18)
- [ ] `codex` adapter
- [ ] Ink TUI
- [ ] `meta serve`: the same core over HTTP for an IDE/phone UI
