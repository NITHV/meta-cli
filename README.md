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
- **Safety**: Claude runs with `--permission-mode acceptEdits` by default
  (edits allowed, shell commands denied). `--yolo` bypasses permissions.
- **State**: every run and event is in SQLite, so `meta show <run>` can replay it.
- **Race**: contestants run through a worker pool capped by `--max` (default 2),
  so a laptop with little RAM isn't swamped. Runs in a race share a `race_id`.

## Roadmap

- [x] `run`, `diff`, `apply`, `discard`, `show`, `runs`
- [x] `race` with a concurrency cap, `stats` per agent:model
- [ ] `gemini` and `codex` adapters
- [ ] Ink TUI
- [ ] `meta serve`: the same core over HTTP for an IDE/phone UI
