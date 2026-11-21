# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(An Electron desktop app; its UI is HTML/CSS in `app/renderer/`.)

## Users

One person: the author, an SRE who builds side projects by directing coding agents. They keep 3–5 agent sessions running at once across several repos, at a laptop, both in daytime and late at night. Since v0.2 the app also ships as a Windows installer from GitHub Releases, so a visitor from the portfolio may install it: a fresh machine must get a clear first run (what's missing, how to fix it) without reading the README.

## Product Purpose

A terminal-first desktop app for running several coding-agent sessions at once: live status per session, each risky session on its own branch, every edit undoable. Success means the user always knows which session needs them, can trust and review what an agent changed, can read the agents' plans and docs comfortably, and never loses track across projects.

## Positioning

Real agent terminals (not a chat imitation) are the main screen, wrapped with what a plain terminal lacks: status from the agent's own lifecycle hooks, git-worktree isolation per session, per-edit snapshots with undo, and a reader for Markdown and diagrams. Claude Code is the primary agent; Codex and Antigravity (agy) must be usable too.

## Operating Context

- Windows 11 laptop with 7.8 GB RAM; the shell is PowerShell.
- Sessions are long-running Claude Code processes in tabs; the user switches between them, approves permission prompts, reviews diffs, commits and opens PRs.
- Work spans several repos under `D:\Metamorphosis`.
- The user often follows along from a phone (the app has a LAN phone view).

## Capabilities and Constraints

- Existing features (keep): session tabs with working / needs-you / done status, file tree, Markdown reader with Mermaid and copy buttons, code viewer, Ctrl+K palette, Ctrl+P quick open, changes list with diff and undo, per-edit timeline, isolated sessions (branch + worktree, apply / PR), night queue, search across files and past chats, snippets, source control with secret guard, token tracker, phone access, themes, notes, recap, learning mode, task board.
- The terminal stays the primary screen.
- Keyboard-first: everything reachable by shortcut or Ctrl+K.
- Windows first; keep RAM use low.
- Zero cost: no paid APIs; LLM features run through the user's Claude subscription.
- Must work in both a bright daytime room and a dark room at night.
- Name: Tando (chosen 2026-11-20; replaced "meta IDE").

## Brand Commitments

Visual bar (chosen 2026-11-19): sit alongside Linear and Raycast. Familiar, calm, precise product UI at their level of craft; no themed or metaphor-driven visual world. The user has ruled out: a Claude/Anthropic-borrowed look, a VS Code clone, anything flashy or gamey, a design that feels empty, and local or cultural theming (Bengaluru, cricket, Namma Metro and similar).

## Evidence on Hand

- The working app in `app/` and its README.
- No users, testimonials or metrics; do not invent any.

## Product Principles

1. The session that needs you is never missed.
2. Every agent change is visible, reviewable and reversible.
3. The terminal is the work; everything else supports it.
4. Agent-agnostic underneath, Claude Code first on the surface.
5. Light on the machine, free to run.
