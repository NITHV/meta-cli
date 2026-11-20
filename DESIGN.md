---
name: "Tando"
description: A calm, precise working window for running several coding-agent sessions, where the terminal is the work.
colors:
  ground: "#151417"
  surface: "#1B1A1E"
  raised: "#242328"
  sidebar-mica: "rgba(30, 29, 33, .74)"
  terminal: "#111013"
  hairline: "#2A292E"
  hairline-strong: "#3A3940"
  hover: "rgba(255, 255, 255, .05)"
  selected: "rgba(255, 255, 255, .08)"
  text: "#F2F1F3"
  text-secondary: "#B2B0B7"
  muted: "#A3A1A8"
  faint: "#8D8B92"
  accent: "#4E8EF7"
  accent-ink: "#FFFFFF"
  accent-wash: "#1E2A40"
  working: "#4E8EF7"
  needs-you: "#FF6363"
  needs-you-wash: "#3A1D1F"
  done: "#3FBF6F"
  idle: "#5C5A61"
  error: "#FF6B60"
  light-ground: "#FFFFFF"
  light-surface: "#F7F6F8"
  light-sidebar: "rgba(239, 237, 241, .94)"
  light-hairline: "#E6E4E8"
  light-text: "#1D1C20"
  light-accent: "#2F6FE4"
  light-needs-you: "#E5484D"
  light-done: "#1E9E50"
typography:
  display:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.25
  headline:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.25
  title:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  reading:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    lineHeight: 1.45
  keycap:
    fontFamily: "Inter Variable, Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
  mono:
    fontFamily: "JetBrains Mono Variable, Cascadia Mono, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  xs: "4px"
  keycap: "5px"
  sm: "6px"
  md: "7px"
  lg: "8px"
  xl: "10px"
  palette: "14px"
  pill: "999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-ghost:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
  button-ghost-hover:
    backgroundColor: "{colors.selected}"
  toolbar-button:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    size: "30px"
  toolbar-button-on:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
  keycap:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.keycap}"
    rounded: "{rounded.keycap}"
    height: "20px"
    padding: "0 5px"
  search-pill:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.faint}"
    rounded: "{rounded.lg}"
    height: "30px"
    padding: "0 6px 0 10px"
  session-row:
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "38px"
    padding: "0 8px"
  session-row-selected:
    backgroundColor: "{colors.selected}"
  status-tile-needs:
    backgroundColor: "{colors.needs-you}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    size: "22px"
  status-tile-working:
    backgroundColor: "{colors.working}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    size: "22px"
  status-tile-done:
    backgroundColor: "{colors.done}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    size: "22px"
  chip:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    height: "22px"
    padding: "0 8px"
  info-row:
    textColor: "{colors.text-secondary}"
    height: "32px"
  action-footer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    height: "40px"
    padding: "0 8px 0 14px"
  action-primary:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 6px 0 10px"
  input:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "8px 10px"
  palette:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.palette}"
    width: "640px"
---

# Design System: Tando

## Overview

**Creative North Star: "The Quiet Frame"**

The terminal is the work. Everything around it is a quiet, precise frame whose only loud job is to say which session needs you and let you answer from the keyboard. The register is the category standard for serious product UI, sitting alongside Linear and Raycast with macOS layout conventions on a Windows 11 window: one unified toolbar, a grouped source list on the left, a label/value inspector on the right, and a context-aware action footer at the bottom.

Density is compact desktop: 13 px body, 30 px controls, 38 px list rows, hairline separators instead of boxes. Grounds are neutral warm grey, close in value so regions separate by hairline rather than by contrast. Color is reserved for status. Glass appears once, on the floating command palette (and its sibling context menus); every other surface paints a solid ground. In the dark theme the sidebar sits over real Windows 11 Mica.

The product is **Tando** (chosen 2026-11-20). The mark (`app/renderer/mark.svg`, also the app icon) is two rounded lanes running in tandem on a graphite tile, with a blue dot above the shorter lane: two sessions side by side, one asking for you. It uses graphite, off-white and the One Blue only, never coral, so the Needs-You Rule holds. The toolbar shows it at 20 px next to the project name.

Rejected outright: the floating-glass launcher look, themed or metaphor-driven worlds, a VS Code clone, a Claude/Anthropic-borrowed look, anything flashy or gamey, and local or cultural theming.

**Key Characteristics:**
- Terminal-first: the centre column always holds the terminal; the frame folds before the terminal shrinks below 80 columns.
- Status as small rounded icon tiles: red-coral needs you, blue working, green done, grey idle.
- Hairline structure (1 px) and tonal grounds; shadows only on things that float.
- Raycast-style keycaps beside every keyboard-reachable action.
- Three first-class themes: dark (with Mica), light (solid) and high contrast.

## Colors

A near-monochrome warm-grey ground with three status hues and one blue that does the interactive work.

### Primary
- **Focus Blue** (`accent`): selection, focus rings (2 px outline), the primary button, links, changed-file markers, search-hit highlight (on `accent-wash`). Darkens to a deeper blue in light theme and lightens to a pale sky blue in high contrast.

### Status
- **Needs-You Coral** (`needs-you`): the session that is waiting on you. Its tile, its row's right-hand label, the needs-you count badge in the segmented control, the session header status and the 5-hour meter when it runs hot. `needs-you-wash` backs it where a tinted area is needed.
- **Working Blue** (`working`): a session that is running. Same hue as Focus Blue by design; the tile shape disambiguates.
- **Done Green** (`done`): finished sessions, new files, passing CI.
- **Idle Grey** (`idle`): queued, paused or idle sessions.
- **Error Red** (`error`): failures, deleted files, destructive hover. Distinct from Needs-You Coral in role even though the hues sit close.

### Neutral
- **Ground** (`ground`): content regions: inspector, reader, empty states, inputs.
- **Surface** (`surface`): the toolbar, the action footer, comparison bars, the sidebar overlay.
- **Raised** (`raised`): controls on a surface: search pill, segmented control track, keycaps, ghost buttons, the palette base.
- **Terminal Black** (`terminal`): the terminal itself, a step darker than Ground so the work reads as the deepest layer.
- **Mica Sidebar** (`sidebar-mica`): translucent sidebar tint over Windows 11 Mica, dark theme only. Light theme uses a near-opaque solid (`light-sidebar`); high contrast uses solid black.
- **Hairline / Hairline Strong**: every separator and control border. Strong is for borders on interactive controls and keycaps.
- **Hover / Selected**: white (dark) or black (light) at low alpha, laid over whatever ground is beneath.
- **Text, Text Secondary, Muted, Faint**: four text steps. Faint is for group headers, metadata and placeholder; it still holds legible contrast on every ground.

Light and high-contrast palettes redefine the same token names; the full sets live in `.impeccable/design.json` under `extensions.themes`.

### Named Rules
**The Needs-You Rule.** Red-coral means "this session needs you" and nothing else. Never use it for decoration, brand emphasis, errors, or a primary button. If a screen shows coral, the user has something to answer.

**The One Blue Rule.** Blue is selection, focus and the primary action. There is no second accent.

**The Same Meaning Rule.** Status colors keep their meaning in every theme; only their values shift for contrast.

## Typography

**UI Font:** Inter Variable (with Segoe UI Variable Text, Segoe UI, system-ui)
**Mono Font:** JetBrains Mono Variable (with Cascadia Mono, Consolas)

Both are bundled locally as variable woff2 from `@fontsource-variable`, loaded with `font-display: block` so the window never flashes a fallback.

**Character:** A neutral, tightly hinted product sans for the frame and a clear code mono for the work. The frame never competes with the terminal.

### Hierarchy
- **Display** (600, 26px, 1.25): start screen title only. Markdown H1 in the reader runs at 24px.
- **Headline** (600, 15 to 17px, 1.25): empty-state titles, dialog titles, reader H2/H3 (18px / 16px).
- **Title** (600, 13px): session name in the header, project name, reader title, file group names.
- **Body** (400 to 500, 13px, 1.45): all frame text. Secondary rows and chips step down to 12 to 12.5px.
- **Reading** (400, 15px, 1.65, max 72ch): the Markdown reader, set in Text Secondary with headings in Text.
- **Label** (600, 11.5px, sentence case): sidebar group headers ("Needs you", "Working"), inspector section headers ("Information", "Changes"). No uppercase, no tracking.
- **Keycap** (500, 11px): key hints in keycaps.
- **Mono** (400, 13px, 1.6): terminal, code blocks, commit message, branch names. Small mono at 11 to 12px for line numbers, git status letters, menu shortcuts and logs.

### Named Rules
**The Sentence-Case Label Rule.** Section and group labels are sentence case at 11.5px semibold in Faint. They name the group; they do not shout.

**The Tabular Numbers Rule.** Token counts, meter values and timings use `font-variant-numeric: tabular-nums`.

## Layout

A fixed desktop chrome around a fluid centre. Top to bottom: a 46px unified toolbar (draggable, with native caption buttons overlaid on the right, 138px reserved), the body, and a 40px action footer. The body is three columns: a 252px sidebar, the centre column (40px session header over the terminal), and a 288px inspector. The Markdown reader opens as a 520px resizable column (minimum 320px) beside the terminal with a 5px drag handle.

The window's minimum size is 600 x 480 so it still fits snapped to half of a 1366px laptop.

Responsive folds, in order, so the terminal keeps at least 80 columns:
- **1280px**: the inspector folds away; its toolbar toggle reopens it as an overlay on the right edge with a floating shadow.
- **1100px**: segmented-control labels and counts hide (icons remain), the search pill drops its text to an icon plus keycap, and secondary footer actions hide.
- **900px**: the sidebar collapses to a 56px rail of status tiles with tooltips; group headers become short hairline ticks. Ctrl+B opens the full sidebar as a 288px overlay. The project name, session project label and branch chip hide; the reader becomes a full overlay over the centre.

Spacing runs on a 2px base, mostly 4 / 6 / 8 / 12 / 16px. Control heights step 20 (keycap), 22 (tile, chip), 28 (icon button, footer action), 30 (toolbar control, primary button), 36 (large button), 38 to 40 (rows, headers, footer).

## Elevation & Depth

Flat by default, layered by tone. Regions separate by a step in ground value plus a 1px hairline; nothing at rest casts a shadow. Depth is reserved for things that float over the work: the command palette, context menus, and the inspector or sidebar when they open as overlays at narrow widths. Small inset highlights (1px white at 12 to 18% alpha) give tiles, the mark and the primary button a faint pressed-in edge.

### Shadow Vocabulary
- **Pop** (`0 1px 0 rgba(255,255,255,.05) inset, 0 18px 48px -12px rgba(0,0,0,.65)` dark; `0 1px 2px rgba(0,0,0,.06), 0 18px 44px -14px rgba(40,20,30,.28)` light): palette, menus, overlay panels.
- **Segment lift** (`0 1px 1px rgba(0,0,0,.25)`): the selected segment in the segmented control.

### Named Rules
**The Float-Only Rule.** A shadow means the element floats above the terminal. Docked panels never take one.

**The One Glass Rule.** Backdrop blur exists only on the command palette (24px blur) and its sibling context menus (20px). Never on docked chrome.

## Shapes

Gently rounded, consistent corners that grow with the object: 4px for small tiles and inline code, 5px keycaps, 6px chips, status tiles and icon buttons, 7px buttons and list rows, 8px inputs, the search pill and the segmented control, 10px code blocks, cards and menus, 14px for the palette. Fully round is reserved for status dots, the needs-you count badge and filter chips. Borders are 1px hairlines; dashed borders mark paused status and board drop targets. Icons are 1.6px-stroke line icons with round caps and joins, 12 to 16px.

## Components

### Buttons
Quiet until needed; only one blue button per context.
- **Shape:** 7px radius; 30px tall (36px large).
- **Primary:** Focus Blue fill, white semibold text, 12px side padding, faint inset top highlight; may carry a translucent keycap. Hover brightens by 8%.
- **Ghost:** Raised fill with a strong hairline border; hover goes to Selected.
- **Icon / toolbar:** 28 to 30px square, Text Secondary glyph, Selected wash on hover and when toggled on.
- **Focus:** 2px Focus Blue outline, 1px offset, on every focusable element.

### Keycaps
Raycast-style: 20px tall, 5px radius, Raised fill, strong hairline border, 11px medium text in Text Secondary. They sit at the right of the search pill, beside every footer action and every palette row that has a shortcut.

### Segmented Control (Sessions / Files / Git)
A Raised track with a 2px inner padding and 8px radius; segments are 26px tall at 6px radius with icon plus label. The selected segment takes the Selected wash (solid white in light theme) and the segment lift shadow. The Sessions segment carries a coral needs-you count badge.

### Session Source List (signature)
Rows are 38px with a 22px status tile, name over project, and a right-hand meta label. Groups read Needs you, then Working, then Done, each under a sentence-case label with its count. In a needs-you row the meta label turns coral. Hover uses Hover; the selected row uses Selected. At 900px the list collapses to the tile rail.

### Status Tiles
22px rounded squares (16px small variant) filled with the status color, white 12px line glyph at 2.2px stroke, faint inset highlight. They are the main status signal everywhere: list, header, inspector.

### Chips
22px, 6px radius, strong hairline border, 12px Text Secondary with an optional 12px icon. Used for model, branch and shell kind in the session header. Filter chips are pill-shaped and turn their border blue on hover.

### Information Inspector
Label/value rows, minimum 32px, separated by hairlines: key in Text Secondary on the left, value medium-weight on the right with an optional status pip. Sections (Information, Changes, Usage) open with a sentence-case label and an optional blue text link on the right.

### Action Footer (signature)
A 40px Surface bar that names what is waiting on the left and lists the keys that answer it on the right (for example Allow, Always, Deny, each with a keycap). The keys change with what the focused session needs. The leading action takes the Selected wash; a 16px hairline separates groups.

### Inputs / Fields
Ground fill, 1px hairline, 8px radius (6px for compact inline fields), 13px sans or 12 to 13px mono for commit messages and command fields. Focus is a 2px Focus Blue outline drawn inside the border.

### Command Palette
640px, 14px radius, Raised at 86% over a 24px blur, strong hairline border, Pop shadow, dimmed scrim below. A 54px input row at 16px type, 40px result rows with the selected row on Selected and matches in blue, and a footer of keycap hints.

## Do's and Don'ts

### Do:
- **Do** keep the terminal the largest region at every width; fold the inspector at 1280px and the sidebar at 900px before the terminal drops under 80 columns.
- **Do** show status as a filled rounded tile in the status color, with a glyph, never color alone.
- **Do** put a keycap beside every action that has a shortcut.
- **Do** separate regions with a 1px hairline and a tonal step, not with shadows or boxes.
- **Do** define every color as a token and redefine it per theme; dark, light and high contrast are all first class.
- **Do** keep motion to 120 to 200ms with `cubic-bezier(.2,.8,.2,1)` on hover, selection and panel collapse only, and drop it under reduced motion.

### Don't:
- **Don't** use red-coral for anything but a session that needs you.
- **Don't** add a second accent color; blue does all interactive work.
- **Don't** use backdrop blur or glass on docked chrome; it belongs to the palette and menus only.
- **Don't** put a shadow on anything that does not float.
- **Don't** turn the frame into a VS Code clone, a Claude/Anthropic-borrowed look, a themed or metaphor-driven world, or anything flashy or gamey.
- **Don't** recolour the mark with coral or add a gradient: coral belongs to needs-you only.
