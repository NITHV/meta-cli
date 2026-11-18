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

## Roadmap

1. `codex` and `gemini` adapters
2. `meta race "<task>" -a claude,gemini,codex`: parallel runs with a concurrency cap
3. `meta stats`: success rate, turns and time per agent
4. Ink TUI, then `meta serve` for a phone UI over the same core
