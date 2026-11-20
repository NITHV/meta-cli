# meta-cli

## Tando (desktop IDE)

A terminal-first desktop app around Claude Code: Claude session tabs, a live file
tree, a Markdown reader with Mermaid diagrams and copy buttons, a code viewer,
Ctrl+P quick open, status dots (working / needs you / done) and a token tracker.

```powershell
cd app; npm install --allow-scripts=electron; cd ..   # once
meta ide                      # open the IDE on the current folder
meta ide D:\path\to\project
```

Also: **Changes** (sidebar) lists the files the active Claude tab edited, with a
diff and **Undo changes**; right-click a tab for **Continue in a new tab** (fresh
session that starts with the end of the old conversation); the **Queue** runs
tasks unattended one by one, each in its own git worktree, for review and Apply
later; the **▾** menu picks the model for new tabs (`--model`, that tab only).
**Timeline** shows every edit in a tab with "Undo back to here"; **Ctrl+Shift+F**
searches files and past Claude chats (click a chat to resume it); **Ctrl+Shift+P**
inserts a saved prompt snippet; **Ctrl+Shift+G** opens source control (stage,
diff, commit, push, and "Write message with Claude" using Haiku).

Everything else is in the **Ctrl+K** command palette: isolated sessions (own
branch + worktree, apply or open a PR), edit files with live Markdown preview,
PDF export, notes per tab, prompt history (Ctrl+Shift+H), one prompt to several
tabs + side-by-side compare, themes, layouts, permission rules, pinned context,
dependency watch, secret guard on commit, CI status, offline dependency docs,
templates, user hooks, ports, scripts, live preview, watch mode, voice typing
(Ctrl+Shift+Space), today's recap, learning mode, the task board, and **phone
access**: watch sessions and answer prompts from your phone on the same Wi-Fi
(off by default; secret link; read-only share links per tab).

Desktop and Start menu shortcuts: `powershell -ExecutionPolicy Bypass -File app\install-shortcuts.ps1`

Keys: Ctrl+T new Claude · Ctrl+Shift+T PowerShell · Ctrl+1–9 / Ctrl+Tab switch ·
Ctrl+P open file (Alt+Enter mentions it in Claude) · Ctrl+B files · Ctrl+\ reader ·
Ctrl+Shift+W close tab · right-click a file for "Start Claude on this file".

How it works: each tab is a real terminal (node-pty + xterm.js) running `claude`
with a fixed `--session-id`, so tabs come back after a restart via `--resume`;
paused tabs use no RAM until clicked. Status comes from Claude Code hooks
(`--settings` with a hooks file) that ping the app over localhost. Tokens are read
from Claude's own logs in `~/.claude/projects`, so tracking is free and local.

## CLI

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

# the web IDE: files, Monaco editor, Claude Code panel, diff review, apply
meta serve                   # opens http://localhost:4321 in your browser
meta serve --lan             # also reachable from your phone on the same Wi-Fi
```

In the IDE, select code and press **Ctrl+I** to send it to the agent with its
file and line numbers. Runs stream live; **Review** opens a side-by-side diff
and **Apply** stages the change in your repo.

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
- **IDE server**: `meta serve` binds to localhost and requires a random token
  (swapped for an HttpOnly SameSite=Strict cookie) plus an `X-Meta` header on
  writes, so other web pages can't drive it (CSRF / DNS-rebinding defense).
  Paths are confined to the repo; `.git` and `.meta` are off limits.
- **Race**: contestants run through a worker pool capped by `--max` (default 2),
  so a laptop with little RAM isn't swamped. Runs in a race share a `race_id`.

## Roadmap

- [x] `run`, `diff`, `apply`, `discard`, `show`, `runs`
- [x] `race` with a concurrency cap, `stats` per agent:model
- [x] `agy` adapter for Antigravity CLI (Google's Gemini CLI replacement; sign in once with `agy`)
- [x] `gemini` adapter (paid API keys only: retired for free/Pro accounts on 2026-06-18)
- [x] `meta serve`: web IDE over the same core (REST + Server-Sent Events)
- [ ] IDE: chat follow-ups on a run (Claude `--resume`), approve tool calls from the UI
- [ ] IDE: integrated terminal, git commit panel
- [ ] Backlog: agy over ACP, `codex` adapter, Ink TUI
