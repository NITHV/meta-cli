---
version: 1
slug: "app-renderer-index-html"
primary_target: "app/renderer/index.html"
related_targets: []
---

# Main window (app/renderer)

Mode: Operate. Audience: one developer running 3–5 coding-agent sessions across repos, day and night, keyboard-first, Windows 11 laptop.
Job: see which session needs you, answer it, review and undo what agents changed, read plans, juggle projects.
Constraints: terminal stays the main area; both light and dark themes first-class; works maximized, on a 1366 laptop and snapped to half-screen (~680 px); light on RAM/GPU.

## Direction contract

THESIS: A calm, precise working window in the Linear/Raycast/macOS register: the terminal is the work, and everything else is a quiet frame that tells you what needs you and lets you act from the keyboard. Refuses the floating-glass launcher look, themed metaphors, and the VS Code clone.

OWN-WORLD: Neutral warm-grey ground (dark #151417 content, #1E1D21 sidebar; light #FFFFFF content, #F1EFF2 sidebar) with a real Windows 11 Mica sidebar where available. One brand red-coral (#FF6363 dark / #E5484D light) that means "needs you" and the brand mark only; blue for working, green for done, grey for queued, each as a small rounded icon tile. Inter for UI, JetBrains Mono for terminal and code (both bundled locally as woff2). Hairline separators, 7–8 px radii, Raycast-style keycaps, label/value "Information" rows.

STORY: The user glances at the sidebar, sees "Needs you" first with red tiles, presses Ctrl+J to jump there, answers from the action footer (Allow ↵ / Always A / Deny N), checks Changes in the inspector, commits or undoes, and moves on.

FIRST VIEWPORT: One unified toolbar (sidebar toggle, product mark, Sessions/Files/Git segmented control with a needs-you badge, centred search with Ctrl K, new session, inspector toggle, native caption buttons). Left: session source list grouped Needs you / Working / Done with icon tiles. Centre: session header (name, project, model, branch chips, elapsed) over the terminal. Right: Information inspector (status, project, model, branch, tokens, changes). Bottom: Raycast-style action footer naming what is waiting and its keys; 5-hour meter under the sidebar. Under 1280 px the inspector folds to a toggle; under 900 px the sidebar collapses to tiles with tooltips and Ctrl+B opens it as an overlay; the terminal keeps ≥80 columns. Signature interaction: the context-aware action footer (keys change with what the focused session needs). Motion: 150–200 ms ease-out on panel collapse and selection only.

FORM: Category standard (canon), sat alongside Linear and Raycast, macOS layout conventions; seed:f1ddbf9f2b61624f.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
