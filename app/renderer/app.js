// Tando window. Everything privileged goes through window.meta (preload.js).
import { init as initFeatures } from './features.js';
import { init as initContent } from './content.js';
import { init as initDevtools } from './devtools.js';
import { init as initExtras } from './extras.js';

const api = window.meta;
let F = null; // feature hooks from features.js, set in boot()
let C = null; // content hooks from content.js (editing, themes, notes…), set in boot()
let D = null; // dev tooling hooks from devtools.js (permissions, CI, pins…), set in boot()
let X = null; // extras.js: phone, preview, watch mode, voice, recap, learning, board
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null && k !== false));
  return n;
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

const S = {
  project: null,
  recent: [],
  files: [],
  sessions: new Map(), // id -> { info, term, fit, el, attached }
  active: null,
  changed: new Map(), // path -> { kind: 'new'|'changed', at }
  open: null, // { path, mode, isMd, data }
  tokens: null,
};
const CHANGE_TTL = 30 * 60_000;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const base = (p) => p.split(/[\\/]/).pop();
const STATUS_LABEL = { working: 'working', needs: 'needs you', done: 'done', idle: 'idle', paused: 'paused' };

// =============================================================== terminals

const THEME = {
  background: '#111013', foreground: '#DCDBDF', cursor: '#F2F1F3', cursorAccent: '#111013',
  selectionBackground: '#2F3A52', black: '#242328', red: '#FF6363', green: '#6AD38F', yellow: '#F2B544',
  blue: '#6AA8FF', magenta: '#C792EA', cyan: '#5FD4D4', white: '#DCDBDF', brightBlack: '#8D8B92',
  brightRed: '#FF8A8A', brightGreen: '#7EE0AE', brightYellow: '#F5CC72', brightBlue: '#94C0FF',
  brightMagenta: '#DDB0F5', brightCyan: '#8BE6E6', brightWhite: '#FFFFFF',
};

function isAppShortcut(e) {
  if (!e.ctrlKey || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (e.shiftKey) return ['t', 'w', 'f', 'g', 'p', 'h', 'i', ' '].includes(k);
  return k === 't' || k === 'p' || k === 'b' || k === 'k' || k === 'j' || k === '\\' || k === 'tab' || /^[1-9]$/.test(k);
}

function makeTerm(info) {
  const node = el('div', { className: 'term', hidden: true });
  $('#terminals').append(node);
  const term = new window.Terminal({
    fontFamily: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    theme: C ? C.termTheme() : THEME,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (isAppShortcut(e)) return false; // let the window handle it
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'c' && term.hasSelection()) { api.clipboardWrite(term.getSelection()); term.clearSelection(); return false; }
    if (e.ctrlKey && k === 'v') { F.paste(s); return false; } // text, or a screenshot saved as a file
    return true;
  });
  const s = { info, term, fit, el: node, attached: false, attaching: null };
  S.sessions.set(info.id, s);
  F.termCreated(s);
  return s;
}

async function attach(s) {
  if (s.attached) return;
  if (s.attaching) return s.attaching;
  s.attaching = (async () => {
    if (!s.term.element) s.term.open(s.el);
    try { s.fit.fit(); } catch { /* not visible yet */ }
    const { buffer, status } = await api.attach(s.info.id, s.term.cols, s.term.rows);
    s.term.write(buffer);
    s.attached = true;
    s.info.running = true;
    s.info.status = status;
    s.term.onData((d) => api.write(s.info.id, d));
    s.term.onResize(({ cols, rows }) => api.resize(s.info.id, cols, rows));
    new ResizeObserver(() => { if (!s.el.hidden) try { s.fit.fit(); } catch { /* ignore */ } }).observe(s.el);
    renderSessions();
  })();
  try { await s.attaching; } catch (e) { toast(e.message); } finally { s.attaching = null; }
}

async function activate(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (S.compare && !S.compare.includes(id)) C.stopCompare();
  S.active = id;
  api.setActive(id);
  for (const x of S.sessions.values()) x.el.hidden = x !== s;
  $('#noSession').hidden = true;
  if (S.compare) for (const x of S.sessions.values()) x.el.hidden = !S.compare.includes(x.info.id);
  renderSessions();
  renderChanges();
  renderTimeline();
  C.renderStats();
  await attach(s);
  requestAnimationFrame(() => { try { s.fit.fit(); } catch { /* ignore */ } s.term.focus(); });
}

function estimateSize() {
  const box = $('#terminals').getBoundingClientRect();
  return { cols: Math.max(40, Math.floor((box.width - 30) / 7.7)), rows: Math.max(10, Math.floor((box.height - 20) / 17)) };
}

async function newSession(kind = 'claude', opts = {}) {
  if (!S.project) return toast('Open a folder first');
  F.beforeCreate();
  try {
    const model = kind === 'claude' ? store.get('meta.model', '') : '';
    const info = await api.createSession({ kind, model, ...estimateSize(), ...opts });
    makeTerm(info);
    await activate(info.id);
  } catch (e) {
    toast(e.message);
  }
}

async function closeSession(id, keepBranch = false) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.info.isolated && !keepBranch) return F.closeIsolated(s);
  const running = s.info.running && s.info.status !== 'paused';
  if (running && !keepBranch && !confirm(`Close "${s.info.name}"? ${s.info.kind === 'claude' ? 'You can resume the conversation later with claude --resume.' : ''}`)) return;
  await api.closeSession(id);
  dropSession(id);
}

/** Remove a tab from the window (the main process has already dropped the session). */
function dropSession(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  s.term.dispose();
  s.el.remove();
  S.sessions.delete(id);
  if (S.active === id) {
    const next = [...S.sessions.values()].find((x) => x.info.project === S.project);
    S.active = null;
    if (next) activate(next.info.id);
  }
  renderSessions();
}

function projectSessions() {
  return [...S.sessions.values()].filter((s) => s.info.project === S.project);
}

function startRename(s, tabEl) {
  const input = el('input', { value: s.info.name, 'aria-label': 'Session name' });
  tabEl.replaceChildren(input);
  input.focus();
  input.select();
  const done = async (save) => {
    if (save && input.value.trim()) {
      const r = await api.renameSession(s.info.id, input.value.trim());
      if (r) s.info.name = r.name;
    }
    renderSessions();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
}

// Status icon tiles (static SVG strings, never user text).
const ICON = {
  needs: '<path d="M12 7v6M12 17v.5"/>',
  working: '<path d="M8 9l3 3-3 3M13 15h4"/>',
  done: '<path d="M6 12l4 4 8-8"/>',
  idle: '<circle cx="12" cy="12" r="4.5"/>',
  paused: '<path d="M10 8v8M14 8v8"/>',
  shell: '<path d="M6 9l3 3-3 3M12 15h6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 7c0 6-12 4-12 10"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
const statusOf = (s) => s.info.status || 'paused';
const isPermission = (s) => statusOf(s) === 'needs' && /permission|approve|allow/i.test(s.info.statusMsg || '');
function tile(s, small = false) {
  const st = statusOf(s);
  const k = st === 'needs' || st === 'done' || st === 'paused' ? st : s.info.kind === 'shell' ? 'shell' : st === 'working' ? 'working' : 'idle';
  return el('span', { className: `tile ${st}${small ? ' sm' : ''}`, innerHTML: svg(k) });
}
function rowMeta(s) {
  const st = statusOf(s);
  if (st === 'needs') return isPermission(s) ? 'permission' : 'waiting';
  if (st === 'working') return s.info.model || 'working';
  if (st === 'paused') return s.info.asleep ? 'asleep' : 'paused';
  return st === 'done' ? 'done' : s.info.kind === 'shell' ? 'shell' : 'idle';
}

function renderHead() {
  const s = S.sessions.get(S.active);
  const head = $('#sessHead');
  head.hidden = !s;
  if (!s) return;
  const st = statusOf(s);
  const nm = el('span', { className: 'nm', textContent: s.info.name, title: 'Double-click to rename' });
  nm.ondblclick = () => startRename(s, nm);
  const close = el('button', { className: 'icon icon-btn', title: 'Close session (Ctrl+Shift+W)', 'aria-label': 'Close session', innerHTML: svg('close') });
  close.onclick = () => closeSession(s.info.id);
  head.replaceChildren(...[
    tile(s, true), nm,
    el('span', { className: 'pj', textContent: base(s.info.project) }),
    s.info.kind === 'claude' ? el('span', { className: 'chip', textContent: s.info.model || 'default model' }) : el('span', { className: 'chip', textContent: 'PowerShell' }),
    s.info.isolated ? el('span', { className: 'chip br', title: 'Runs on its own branch and worktree', innerHTML: svg('branch') }, s.info.isolated.branch) : null,
    el('span', { className: 'st ' + st, textContent: st === 'needs' ? (isPermission(s) ? 'Needs your permission' : 'Waiting for you') : STATUS_LABEL[st] }),
    close].filter(Boolean));
  head.oncontextmenu = (e) => { e.preventDefault(); tabMenu(s, e.clientX, e.clientY, nm); };
}

function renderInspector() {
  const s = S.sessions.get(S.active);
  const box = $('#inspInfo');
  if (!s) { box.replaceChildren(el('div', { className: 'empty-list', textContent: 'Pick a session to see its details.' })); return; }
  const st = statusOf(s);
  const tok = S.tokens?.bySession?.[s.info.claudeId];
  const pipColor = { needs: 'var(--needs)', working: 'var(--working)', done: 'var(--done)' }[st] || 'var(--idle)';
  const branch = s.info.isolated?.branch || (gitState?.repo ? gitState.branch : '');
  const rows = [
    ['Status', el('span', { className: 'v' }, el('span', { className: 'pip', style: `background:${pipColor}` }), st === 'needs' ? 'Needs you' : STATUS_LABEL[st].replace(/^./, (c) => c.toUpperCase()))],
    ['Project', base(s.info.project)],
    ['Kind', s.info.kind === 'claude' ? 'Claude Code' : 'PowerShell'],
    s.info.kind === 'claude' ? ['Model', s.info.model ? s.info.model.replace(/^./, (c) => c.toUpperCase()) : 'Default'] : null,
    branch ? ['Branch', branch + (s.info.isolated ? ' (own worktree)' : '')] : null,
    tok ? ['Tokens', fmt(tok.total)] : null,
  ].filter(Boolean);
  box.replaceChildren(...rows.map(([k, v]) => el('div', { className: 'irow' }, el('span', { className: 'k', textContent: k }), typeof v === 'string' ? el('span', { className: 'v', textContent: v, title: v }) : v)));
}

function renderFooter() {
  const all = [...S.sessions.values()];
  const needing = all.filter((s) => statusOf(s) === 'needs');
  const s = S.sessions.get(S.active);
  const activeNeeds = s && statusOf(s) === 'needs';
  const perm = s && isPermission(s);
  for (const id of ['#actAllow', '#actAlways', '#actDeny']) $(id).hidden = !perm;
  $('#actNext').hidden = !needing.some((x) => x.info.id !== S.active);
  $('#actSep').hidden = !perm;
  const who = $('#sbNeeds');
  if (activeNeeds) {
    const msg = (s.info.statusMsg || '').replace(/^Claude\s+/i, '');
    // replaceChildren turns a null argument into the text "null", so drop the optional part instead.
    who.replaceChildren(...[tile(s, true), el('span', { textContent: `${s.info.name} ${perm ? 'needs your permission' : 'is waiting for you'}` }), msg && !perm ? el('span', { className: 'msg', textContent: `· ${msg}` }) : null].filter(Boolean));
  } else if (needing.length) {
    who.replaceChildren(tile(needing[0], true), el('span', { textContent: needing.length === 1 ? `${needing[0].info.name} needs you` : `${needing.length} sessions need you` }));
  } else who.replaceChildren();
}

function nextNeeding() {
  const list = [...S.sessions.values()].filter((s) => statusOf(s) === 'needs');
  if (!list.length) return toast('Nothing is waiting for you');
  const i = list.findIndex((s) => s.info.id === S.active);
  const n = list[(i + 1) % list.length];
  if (n.info.project !== S.project) enterProject(n.info.project).then(() => activate(n.info.id));
  else activate(n.info.id);
}

function answer(keys) {
  const s = S.sessions.get(S.active);
  if (!s || !isPermission(s)) return;
  api.write(s.info.id, keys);
  s.term.focus();
}

function renderSessions() {
  const list = projectSessions();

  // Every project's sessions in one source list, grouped by what each needs from you.
  // This project's sessions sort first inside each group. Clicking another project's
  // session switches to that project.
  const GROUPS = [['needs', 'Needs you'], ['working', 'Working'], ['done', 'Done'], ['rest', 'Idle']];
  const groupOf = (s) => { const st = statusOf(s); return st === 'needs' || st === 'working' || st === 'done' ? st : 'rest'; };
  const order = [...S.sessions.values()].sort((a, b) => (a.info.project === S.project ? 0 : 1) - (b.info.project === S.project ? 0 : 1));
  const multi = new Set(order.map((s) => s.info.project)).size > 1;
  $('#sessionList').replaceChildren(...GROUPS.flatMap(([g, label]) => {
    const items = order.filter((s) => groupOf(s) === g);
    if (!items.length) return [];
    return [
      el('div', { className: 'sgroup' }, el('span', { textContent: label }), el('span', { className: 'n', textContent: String(items.length) })),
      ...items.map((s) => {
        const st = statusOf(s);
        const idx = list.indexOf(s);
        const r = el('button', {
          className: `srow ${st}` + (s.info.id === S.active ? ' on' : ''),
          title: `${s.info.name} · ${base(s.info.project)} · ${rowMeta(s)}${idx >= 0 && idx < 9 ? ` · Ctrl+${idx + 1}` : ''}`,
        },
        tile(s),
        el('span', { className: 'lab' },
          el('span', { className: 'nm', textContent: s.info.name }),
          multi || s.info.isolated ? el('span', { className: 'pj', textContent: base(s.info.project) + (s.info.isolated ? ' · own branch' : '') }) : null),
        el('span', { className: 'r', textContent: rowMeta(s) }));
        r.onclick = () => (s.info.project === S.project ? activate(s.info.id) : enterProject(s.info.project).then(() => activate(s.info.id)));
        r.ondblclick = () => s.info.project === S.project && startRename(s, r.querySelector('.nm'));
        r.oncontextmenu = (e) => { e.preventDefault(); tabMenu(s, e.clientX, e.clientY, r.querySelector('.nm')); };
        return r;
      }),
    ];
  }));
  if (!S.sessions.size) $('#sessionList').append(el('div', { className: 'empty-list', textContent: 'No sessions yet. Ctrl+T starts one.' }));
  $('#noSession').hidden = list.length > 0 && !!S.active;
  if (!S.active || !S.sessions.has(S.active)) for (const x of S.sessions.values()) x.el.hidden = true;

  const all = [...S.sessions.values()];
  const here = all.filter((s) => s.info.project === S.project);
  const needs = all.filter((s) => s.info.status === 'needs').length; // counts every project: you want to know
  const busy = here.filter((s) => s.info.status === 'working' || s.info.status === 'needs').length;
  $('#sbSessions').textContent = `${here.length} session${here.length === 1 ? '' : 's'} open${busy ? ` · ${busy} working` : ''}`;
  $('#needsBadge').textContent = String(needs);
  $('#needsBadge').hidden = !needs;
  document.title = needs ? `(${needs}) Tando` : 'Tando';
  renderHead();
  renderInspector();
  renderFooter();
}

// =============================================================== files

const openDirsKey = () => `meta.dirs.${S.project}`;

function buildTree(paths) {
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let n = root;
    for (const d of parts.slice(0, -1)) {
      if (!n.dirs.has(d)) n.dirs.set(d, { dirs: new Map(), files: [] });
      n = n.dirs.get(d);
    }
    n.files.push(p);
  }
  return root;
}

function changeOf(p) {
  const c = S.changed.get(p);
  return c && Date.now() - c.at < CHANGE_TTL ? c : null;
}

function renderTree() {
  const openDirs = new Set(store.get(openDirsKey(), []));
  const frag = document.createDocumentFragment();
  const dirHasChange = (prefix) => [...S.changed.keys()].some((p) => p.startsWith(prefix) && changeOf(p));
  const walk = (node, depth, prefix) => {
    for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix + name;
      const isOpen = openDirs.has(path);
      const row = el('button', { className: 'row dir' },
        el('span', { className: 'chev', innerHTML: `<svg class="chev-i${isOpen ? ' open' : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>` }),
        el('span', { className: 'name', textContent: name }),
        !isOpen && dirHasChange(path + '/') ? el('span', { className: 'cdot' }) : null);
      row.style.paddingLeft = `${14 + depth * 14}px`;
      row.onclick = () => {
        isOpen ? openDirs.delete(path) : openDirs.add(path);
        store.set(openDirsKey(), [...openDirs]);
        renderTree();
      };
      frag.append(row);
      if (isOpen) walk(child, depth + 1, path + '/');
    }
    for (const f of node.files.sort((a, b) => a.localeCompare(b))) {
      const c = changeOf(f);
      const row = el('button', { className: 'row file' + (S.open?.path === f ? ' active' : ''), title: f },
        el('span', { className: 'name', textContent: base(f) }),
        D?.isPinned(f) ? el('span', { className: 'pin', textContent: 'pinned', title: 'New Claude tabs start with this file' }) : null,
        c?.kind === 'new' ? el('span', { className: 'badge', textContent: 'new' }) : c ? el('span', { className: 'cdot' }) : null);
      row.style.paddingLeft = `${28 + depth * 14}px`;
      row.onclick = () => openFile(f);
      row.oncontextmenu = (e) => { e.preventDefault(); fileMenu(f, e.clientX, e.clientY); };
      frag.append(row);
    }
  };
  walk(buildTree(S.files), 0, '');
  $('#tree').replaceChildren(frag);
  const n = [...S.changed.keys()].filter(changeOf).length;
  $('#changedCount').textContent = n ? String(n) : '';
  $('#changedCount').title = n ? `${n} file${n === 1 ? '' : 's'} changed recently` : '';
}

function fileMenu(f, x, y) {
  showMenu(x, y, [
    ['Open', () => openFile(f)],
    ['Mention in Claude', () => mention(f)],
    ['Start Claude on this file', () => startOnFile(f)],
    [D.isPinned(f) ? 'Unpin' : 'Pin for new sessions', () => D.togglePin(f)],
    null,
    ['Copy path', () => api.clipboardWrite(f)],
    ['Show in Explorer', () => api.reveal(f)],
  ]);
}

function mention(f) {
  const s = S.sessions.get(S.active);
  if (!s || s.info.kind !== 'claude') return toast('Open a Claude session first');
  api.write(s.info.id, `@${f} `);
  s.term.focus();
}

function startOnFile(f) {
  const name = base(f).replace(/\.[^.]+$/, '');
  newSession('claude', { name, prompt: `Read ${f} and carry out what it describes. Ask me before anything risky.` });
}

// =============================================================== reader

let monacoReady = null;
let codeEditor = null;

function loadMonaco() {
  monacoReady ??= new Promise((resolve) => {
    window.MonacoEnvironment = { getWorkerUrl: () => '../node_modules/monaco-editor/min/vs/editor/editor.worker.js' };
    window.require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    window.require(['vs/editor/editor.main'], () => {
      const m = window.monaco;
      m.editor.defineTheme('meta-light', {
        base: 'vs', inherit: true, rules: [],
        colors: { 'editor.background': '#FFFFFF', 'diffEditor.insertedLineBackground': '#15803D14', 'diffEditor.removedLineBackground': '#B91C1C14' },
      });
      m.editor.defineTheme('meta', {
        base: 'vs-dark', inherit: true, rules: [],
        colors: {
          'editor.background': '#16181D', 'editorLineNumber.foreground': '#5C6474', 'editor.lineHighlightBackground': '#1E2128',
          'diffEditor.insertedLineBackground': '#4ECB8F14', 'diffEditor.insertedTextBackground': '#4ECB8F30',
          'diffEditor.removedLineBackground': '#F06A6A14', 'diffEditor.removedTextBackground': '#F06A6A30',
          'diffEditorGutter.insertedLineBackground': '#4ECB8F22', 'diffEditorGutter.removedLineBackground': '#F06A6A22',
        },
      });
      // Creating the editor with the theme is what installs the theme's token colors,
      // which Markdown code blocks (colorize) also use. setTheme() alone doesn't.
      codeEditor = m.editor.create($('#codeView'), {
        readOnly: true, automaticLayout: true, minimap: { enabled: false }, theme: C.monacoTheme(),
        fontFamily: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, monospace', fontSize: 13, scrollBeyondLastLine: false,
        renderLineHighlight: 'none', domReadOnly: true,
      });
      codeEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => C.save());
      resolve(m);
    });
  });
  return monacoReady;
}

function langFor(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  const map = { ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', json: 'json', md: 'markdown', css: 'css', html: 'html', py: 'python', ps1: 'powershell', sh: 'shell', yml: 'yaml', yaml: 'yaml', kt: 'kotlin', java: 'java', xml: 'xml', go: 'go', rs: 'rust', sql: 'sql', toml: 'ini', ini: 'ini', bat: 'bat', cs: 'csharp', cpp: 'cpp', c: 'c' };
  return map[ext] || 'plaintext';
}

/** The reader shows one pane at a time. Files: md | code | diff. Panels: the rest. */
const PANES = { md: '#mdView', code: '#codeView', diff: '#diffView', queue: '#queueView', search: '#searchView', git: '#gitView', timeline: '#timelineView', snippets: '#snippetsView', ports: '#portsView', notes: '#notesView', perms: '#permsView', docs: '#docsView', hooks: '#hooksView',
  phone: '#phoneView', preview: '#previewView', doc: '#docView', board: '#boardView' };
const FILE_PANES = new Set(['md', 'code', 'diff']);
function pane(name) {
  for (const [k, sel] of Object.entries(PANES)) $(sel).hidden = k !== name;
  const editing = C?.isEditing();
  $('#editBtn').hidden = !(name === 'md' || name === 'code') || editing || !!S.open?.data?.binary;
  $('#pdfBtn').hidden = name !== 'md' || editing;
  $('#doneBtn').hidden = !editing;
  if (!editing) $('#reader').classList.remove('split');
  $('#mentionBtn').hidden = !FILE_PANES.has(name);
  $('#codeBtn').hidden = !FILE_PANES.has(name);
  if (name !== 'diff') $('#revertBtn').hidden = true;
  if (name !== 'md' && name !== 'code') $('#viewToggle').hidden = true;
}

function openPanel(name, title, meta) {
  if (C?.isEditing()) {
    // A panel replaces the file view: finish editing first (asks before discarding unsaved changes).
    C.stopEdit().then((stopped) => { if (stopped) openPanel(name, title, meta); });
    return;
  }
  S.open = { path: '', mode: name, isMd: false, data: null };
  $('#readerTitle').textContent = title;
  $('#readerMeta').textContent = meta;
  showReader(true);
  pane(name);
}

function showReader(show) {
  $('#reader').hidden = !show;
  $('#resizer').hidden = !show;
  document.body.classList.toggle('reading', !!show);
  if (!show) { S.open = null; renderTree(); }
  const s = S.sessions.get(S.active);
  requestAnimationFrame(() => { try { s?.fit.fit(); } catch { /* ignore */ } });
}

async function openFile(p, { keepScroll = false, line = 0 } = {}) {
  if (C?.isEditing() && C.editingPath() !== p) {
    await C.stopEdit();
    if (C.isEditing()) return; // user chose to keep editing
  }
  let data;
  try { data = await api.readFile(p); } catch (e) { return toast(e.message); }
  const isMd = data.html != null;
  const keep = S.open?.path === p && (S.open.mode === 'read' || S.open.mode === 'source');
  const mode = line ? 'source' : keep ? S.open.mode : (isMd ? 'read' : 'source');
  S.open = { path: p, mode, isMd, data };
  $('#readerTitle').textContent = base(p);
  $('#readerMeta').textContent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  $('#viewToggle').hidden = !isMd;
  for (const b of $('#viewToggle').children) b.classList.toggle('on', b.dataset.mode === mode);
  showReader(true);
  renderTree();
  if (data.binary) {
    pane('md');
    $('#mdView').replaceChildren(el('p', { className: 'muted', textContent: `Binary or large file (${fmt(data.size)} bytes). Not shown.` }));
    return;
  }
  if (isMd && mode === 'read') await renderMarkdown(data, keepScroll);
  else {
    await renderCode(p, data.content);
    if (line) {
      codeEditor.revealLineInCenter(line);
      codeEditor.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1e4 });
    }
  }
}

async function renderMarkdown(data, keepScroll, preview = false) {
  const view = $('#mdView');
  const top = keepScroll ? view.scrollTop : 0;
  if (!preview) { pane('md'); $('#viewToggle').hidden = false; }
  view.innerHTML = data.html; // produced by markdown-it in the main process with raw HTML disabled
  const dir = S.open.path.includes('/') ? S.open.path.slice(0, S.open.path.lastIndexOf('/') + 1) : '';

  for (const img of view.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!/^(https?:|data:)/i.test(src)) img.src = 'app://project/' + encodeURI(normalize(dir + src));
  }
  for (const a of view.querySelectorAll('a[href]')) {
    a.onclick = (e) => {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (/^https?:/i.test(href)) api.openExternal(href);
      else if (href.startsWith('#')) view.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView();
      else openFile(normalize(dir + href.split('#')[0]));
    };
  }
  for (const btn of view.querySelectorAll('.codeblock .copy')) {
    btn.onclick = () => {
      api.clipboardWrite(btn.parentElement.querySelector('code').textContent);
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    };
  }
  const blocks = [...view.querySelectorAll('.mermaid-src')];
  if (blocks.length) {
    // Diagram colors come from the live theme tokens, so light and high contrast match the reader.
    const tok = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    window.mermaid.initialize({
      startOnLoad: false, theme: 'base', securityLevel: 'strict',
      themeVariables: {
        darkMode: tok('color-scheme') !== 'light',
        background: tok('--base'), mainBkg: tok('--raised'), primaryColor: tok('--raised'), secondaryColor: tok('--surface'), tertiaryColor: tok('--surface'),
        primaryBorderColor: tok('--line-strong'), nodeBorder: tok('--line-strong'), clusterBkg: tok('--surface'), clusterBorder: tok('--line'),
        primaryTextColor: tok('--text'), textColor: tok('--text'), lineColor: tok('--muted'),
        edgeLabelBackground: tok('--base'), labelBackground: tok('--base'),
        fontFamily: 'Inter Variable, Segoe UI, sans-serif', fontSize: '14px',
      },
    });
    let n = 0;
    for (const b of blocks) {
      try {
        const { svg } = await window.mermaid.render(`mmd${Date.now()}${n++}`, b.dataset.src);
        b.innerHTML = svg;
      } catch (e) {
        b.classList.add('error');
        b.textContent = 'Diagram error: ' + (e?.message || e);
      }
    }
  }
  view.scrollTop = top;
  F.markdownRendered(view);
  // Syntax colors for fenced code: Monaco's tokenizer, our own palette (style.css .tk-*).
  const pres = [...view.querySelectorAll('.codeblock pre')].filter((p) => p.dataset.lang);
  if (pres.length) {
    const m = await loadMonaco();
    for (const pre of pres) {
      const code = pre.querySelector('code');
      const lang = langFor('x.' + pre.dataset.lang) !== 'plaintext' ? langFor('x.' + pre.dataset.lang) : pre.dataset.lang;
      try { code.innerHTML = await highlight(m, code.textContent, lang); } catch { /* leave plain */ }
    }
  }
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function highlight(m, text, lang) {
  await m.editor.colorize('', lang, {}); // makes Monaco load the language's tokenizer
  const lines = text.replace(/\n$/, '').split('\n');
  const toks = m.editor.tokenize(lines.join('\n'), lang);
  return lines.map((line, i) => {
    const t = toks[i] || [];
    if (!t.length) return escHtml(line);
    return t.map((tok, j) => {
      const end = j + 1 < t.length ? t[j + 1].offset : line.length;
      const kind = (tok.type.split('.')[0] || 'text').replace(/[^a-z-]/g, '');
      return `<span class="tk-${kind}">${escHtml(line.slice(tok.offset, end))}</span>`;
    }).join('');
  }).join('\n');
}

function normalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

async function renderCode(p, content) {
  pane('code');
  $('#viewToggle').hidden = !S.open?.isMd;
  const m = await loadMonaco();
  const top = S.open?.path === p ? codeEditor.getScrollTop() : 0;
  const old = codeEditor.getModel();
  codeEditor.setModel(m.editor.createModel(content, langFor(p)));
  old?.dispose();
  codeEditor.setScrollTop(top);
}

// ---------- diffs (per-session changes and queue results)

let diffEditor = null;

/** Show before/after in Monaco's diff view. onRevert, when given, enables "Undo changes". */
async function openDiff({ path: p, before, after, meta, onRevert }) {
  const m = await loadMonaco();
  S.open = { path: p, mode: 'diff', isMd: false, data: null };
  $('#readerTitle').textContent = base(p);
  $('#readerMeta').textContent = meta;
  showReader(true);
  pane('diff');
  diffEditor ??= m.editor.createDiffEditor($('#diffView'), {
    readOnly: true, automaticLayout: true, minimap: { enabled: false }, theme: C.monacoTheme(), renderSideBySide: false,
    fontFamily: '"JetBrains Mono Variable", "Cascadia Mono", Consolas, monospace', fontSize: 13, scrollBeyondLastLine: false, originalEditable: false,
  });
  const old = diffEditor.getModel();
  const lang = langFor(p);
  diffEditor.setModel({ original: m.editor.createModel(before, lang), modified: m.editor.createModel(after, lang) });
  old?.original.dispose();
  old?.modified.dispose();
  $('#revertBtn').hidden = !onRevert;
  $('#revertBtn').onclick = async () => {
    if (!confirm(`Undo this session's changes to ${p}? The file goes back to how it was before.`)) return;
    try { await onRevert(); toast(`Reverted ${p}`); showReader(false); renderChanges(); } catch (e) { toast(e.message); }
  };
  renderTree();
}

// ---------- changes made by the active session

let changesTimer;
function scheduleChanges() { clearTimeout(changesTimer); changesTimer = setTimeout(renderChanges, 250); }

async function renderChanges() {
  const s = S.sessions.get(S.active);
  const box = $('#changeList');
  if (!s || s.info.kind !== 'claude') { box.replaceChildren(el('div', { className: 'empty-list', textContent: 'Files a Claude session edits show up here, with a diff and undo.' })); $('#changesCount').textContent = ''; return; }
  let list = [];
  try { list = await api.changes(s.info.id); } catch { /* ignore */ }
  $('#changesCount').textContent = list.length ? String(list.length) : '';
  box.replaceChildren(...list.map((c) => {
    const r = el('button', { className: 'row file' + (S.open?.mode === 'diff' && S.open.path === c.path ? ' active' : ''), title: c.path },
      el('span', { className: 'name', textContent: c.path }),
      el('span', { className: 'kind ' + c.kind, textContent: c.kind }));
    r.onclick = async () => {
      try {
        const d = await api.changeDiff(s.info.id, c.path);
        openDiff({ path: c.path, before: d.before, after: d.after, meta: `changed by ${s.info.name}`, onRevert: () => api.revertChange(s.info.id, c.path) });
      } catch (e) { toast(e.message); }
    };
    return r;
  }));
  if (!list.length) box.append(el('div', { className: 'row muted', textContent: 'No edits in this session yet' }));
}

// ---------- night queue

let queue = [];

function openQueue() {
  openPanel('queue', 'Queue', 'runs unattended, one task at a time');
  renderQueue();
  $('#queueTask').focus();
}

function renderQueue() {
  const mine = queue.filter((q) => q.project === S.project);
  const pending = mine.filter((q) => q.status === 'pending').length;
  const running = mine.find((q) => q.status === 'running');
  const ready = mine.filter((q) => q.status === 'done').length;
  $('#queueSummary').textContent = [running && '1 running', pending && `${pending} waiting`, ready && `${ready} to review`].filter(Boolean).join(' · ') || 'Empty';
  $('#queueState').textContent = running ? 'Running…' : pending ? `${pending} waiting` : 'Idle';
  $('#queueStart').hidden = !!running;
  $('#queueStart').disabled = !pending;
  $('#queueStop').hidden = !running;
  if ($('#queueView').hidden) return;
  $('#queueList').replaceChildren(...[...mine].reverse().map((q) => {
    const actions = el('div', { className: 'qactions' });
    const files = el('div', { className: 'qfiles' });
    if (q.status === 'done' && q.files?.length) {
      const review = el('button', { className: 'ghost small', textContent: `Review ${q.files.length} file(s)` });
      review.onclick = async () => {
        try {
          const list = await api.queueDiff(q.id);
          files.replaceChildren(...list.map((f) => {
            const b = el('button', { textContent: f.path });
            b.onclick = () => openDiff({ path: f.path, before: f.before, after: f.after, meta: `queue result · ${q.task.slice(0, 40)}` });
            return b;
          }));
        } catch (e) { toast(e.message); }
      };
      const apply = el('button', { className: 'primary', textContent: 'Apply' });
      apply.style.height = '26px';
      apply.onclick = async () => { try { await api.queueApply(q.id); toast('Applied. Changes are staged in git: review and commit.'); } catch (e) { toast(e.message); } };
      actions.append(review, apply);
    }
    if (q.status === 'done' || q.status === 'failed' || q.status === 'cancelled') {
      const discard = el('button', { className: 'ghost small', textContent: 'Discard' });
      discard.onclick = async () => { try { await api.queueDiscard(q.id); } catch (e) { toast(e.message); } };
      actions.append(discard);
    }
    if (q.status !== 'running') {
      const remove = el('button', { className: 'ghost small', textContent: 'Remove' });
      remove.onclick = async () => { try { queue = await api.queueRemove(q.id); renderQueue(); } catch (e) { toast(e.message); } };
      actions.append(remove);
    }
    const when = q.endedAt ? `finished ${new Date(q.endedAt).toLocaleTimeString()}` : q.startedAt ? `started ${new Date(q.startedAt).toLocaleTimeString()}` : 'waiting';
    return el('div', { className: 'qitem' },
      el('div', { className: 'qtop' },
        el('span', { className: 'qstatus ' + q.status, textContent: q.status === 'done' ? 'ready to review' : q.status }),
        el('span', { className: 'qmeta', textContent: `${q.model || 'default model'}${q.yolo ? ' · shell allowed' : ''} · ${when}` })),
      el('div', { className: 'qtask', textContent: q.task }),
      q.status === 'running' && q.log?.length ? el('div', { className: 'qlog', textContent: q.log.slice(-8).join('\n') }) : null,
      q.summary && q.status !== 'running' ? el('div', { className: 'qsum', textContent: q.summary }) : null,
      q.status === 'done' && !q.files?.length ? el('div', { className: 'qmeta', textContent: 'No file changes.' }) : null,
      files,
      actions);
  }));
  if (!mine.length) $('#queueList').append(el('p', { className: 'note', textContent: 'Nothing queued. Add tasks above, then press Run queue before you go to bed.' }));
}

// ---------- search (files + past chats)

let searchScope = 'files';
let searchTimer;

function openSearch() {
  openPanel('search', 'Search', S.project ? base(S.project) : '');
  $('#searchInput').focus();
  $('#searchInput').select();
  runSearch();
}

function highlightText(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(text); return frag; }
  const lt = text.toLowerCase(), lq = q.toLowerCase();
  let i = 0, j;
  while ((j = lt.indexOf(lq, i)) >= 0) {
    frag.append(text.slice(i, j), el('mark', { textContent: text.slice(j, j + q.length) }));
    i = j + q.length;
  }
  frag.append(text.slice(i));
  return frag;
}

async function runSearch() {
  const q = $('#searchInput').value.trim();
  const box = $('#searchResults');
  if (q.length < 2) { box.replaceChildren(el('p', { className: 'note', textContent: 'Type at least 2 characters.' })); return; }
  const scope = searchScope;
  let results;
  try { results = scope === 'files' ? await api.searchFiles(q) : await api.searchChats(q); } catch (e) { return toast(e.message); }
  if (scope !== searchScope || q !== $('#searchInput').value.trim()) return; // a newer search started
  if (!results.length) { box.replaceChildren(el('p', { className: 'note', textContent: 'No matches.' })); return; }
  if (scope === 'files') {
    const groups = new Map();
    for (const r of results) { if (!groups.has(r.path)) groups.set(r.path, []); groups.get(r.path).push(r); }
    box.replaceChildren(...[...groups].map(([p, hits]) => el('div', { className: 'rgroup' },
      el('div', { className: 'rfile' }, base(p), el('span', { className: 'muted', textContent: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '' })),
      ...hits.slice(0, 20).map((h) => {
        const b = el('button', { className: 'rhit' }, el('span', { className: 'ln', textContent: h.line }), el('span', { className: 'tx' }, highlightText(h.text, q)));
        b.onclick = () => openFile(h.path, { line: h.line });
        return b;
      }))));
    if (results.length >= 300) box.append(el('p', { className: 'note', textContent: 'Showing the first 300 matches.' }));
  } else {
    box.replaceChildren(...results.map((r) => {
      const b = el('button', { className: 'rchat' },
        el('span', { className: 'rt', textContent: r.title }),
        el('span', { className: 'rs' }, highlightText(r.snippet, q)),
        el('span', { className: 'rm', textContent: `${r.hits} match${r.hits > 1 ? 'es' : ''} · ${new Date(r.at).toLocaleString()}${r.sessionId ? ' · open in a tab' : ' · click to resume'}` }));
      b.onclick = async () => {
        if (r.sessionId && S.sessions.has(r.sessionId)) return activate(r.sessionId);
        try {
          const info = await api.resumeChat(r.claudeId, r.title, ...Object.values(estimateSize()));
          if (!S.sessions.has(info.id)) makeTerm(info);
          activate(info.id);
        } catch (e) { toast(e.message); }
      };
      return b;
    }));
  }
}

// ---------- source control

let gitState = null;
let gitTimer;
function scheduleGit() { clearTimeout(gitTimer); gitTimer = setTimeout(refreshGit, 800); }

async function refreshGit() {
  try { gitState = await api.gitStatus(); } catch { gitState = { repo: false }; }
  const sum = $('#gitSummary');
  if (!gitState.repo) sum.textContent = 'Not a git repository';
  else {
    const n = gitState.files.length;
    sum.textContent = `${gitState.branch}${n ? ` · ${n} changed` : ' · clean'}${gitState.ahead ? ` · ${gitState.ahead} to push` : ''}`;
  }
  if (!$('#gitView').hidden) renderGit();
  renderInspector();
}

function openGit() {
  openPanel('git', 'Source control', '');
  refreshGit().then(() => $('#commitMsg').focus());
}

function renderGit() {
  const g = gitState;
  if (!g?.repo) { $('#gitFiles').replaceChildren(el('p', { className: 'note', textContent: 'This folder is not a git repository.' })); return; }
  $('#gitBranch').textContent = g.branch;
  $('#gitAhead').textContent = g.ahead ? `${g.ahead} commit(s) to push` : g.ahead === 0 ? 'up to date' : '';
  const staged = g.files.filter((f) => f.staged);
  const unstaged = g.files.filter((f) => f.unstaged || f.untracked);
  const row = (f, isStaged) => {
    const r = el('div', { className: 'grow-row' });
    const open = el('button', { className: 'gp', textContent: f.path, title: f.path });
    open.onclick = async () => {
      try {
        const d = await api.gitDiff(f.path, isStaged);
        openDiff({ path: f.path, before: d.before, after: d.after, meta: isStaged ? 'staged' : f.untracked ? 'new file' : 'not staged' });
      } catch (e) { toast(e.message); }
    };
    const act = el('button', { className: 'gbtn', textContent: isStaged ? 'Unstage' : 'Stage' });
    act.onclick = async () => { try { await (isStaged ? api.gitUnstage([f.path]) : api.gitStage([f.path])); refreshGit(); } catch (e) { toast(e.message); } };
    r.append(el('span', { className: 'gc', textContent: f.untracked ? 'U' : (isStaged ? f.code[0] : f.code.slice(-1)) }), open, act);
    return r;
  };
  const group = (title, files, isStaged) => {
    if (!files.length) return null;
    const all = el('button', { className: 'link', textContent: isStaged ? 'Unstage all' : 'Stage all' });
    all.onclick = async () => { try { await (isStaged ? api.gitUnstage(files.map((f) => f.path)) : api.gitStage(files.map((f) => f.path))); refreshGit(); } catch (e) { toast(e.message); } };
    return el('div', {}, el('div', { className: 'ggroup-title' }, `${title} (${files.length})`, all), ...files.map((f) => row(f, isStaged)));
  };
  $('#gitFiles').replaceChildren(...[group('STAGED', staged, true), group('CHANGES', unstaged, false)].filter(Boolean));
  if (!g.files.length) $('#gitFiles').append(el('p', { className: 'note', textContent: 'Nothing to commit. Working tree clean.' }));
  $('#gitCommit').disabled = !staged.length;
}

// ---------- timeline

function openTimeline() {
  const s = S.sessions.get(S.active);
  if (!s || s.info.kind !== 'claude') return toast('Pick a Claude tab first');
  openPanel('timeline', 'Timeline', s.info.name);
  renderTimeline();
}

async function renderTimeline() {
  if ($('#timelineView').hidden) return;
  const s = S.sessions.get(S.active);
  if (!s) return;
  let events = [];
  try { events = await api.timeline(s.info.id); } catch (e) { return toast(e.message); }
  const list = $('#timelineList');
  const undo = async (evId, label) => {
    if (!confirm(`Undo ${label}? Files go back to how they were at that point.`)) return;
    try { const r = await api.timelineUndoTo(s.info.id, evId); toast(`Undid ${r.edits} edit(s) in ${r.files} file(s)`); renderTimeline(); renderChanges(); } catch (e) { toast(e.message); }
  };
  list.replaceChildren(...[...events].reverse().map((ev, idx) => {
    const main = el('button', { className: 'tl-main' },
      el('span', { className: 'tl-file', textContent: ev.file }),
      el('span', { className: 'tl-meta', textContent: `${ev.created ? 'created' : ev.deleted ? 'deleted' : ev.tool.toLowerCase()} · ${new Date(ev.at).toLocaleTimeString()}` }));
    main.onclick = async () => {
      try { const d = await api.timelineDiff(s.info.id, ev.id); openDiff({ path: d.file, before: d.before, after: d.after, meta: `one edit · ${new Date(ev.at).toLocaleTimeString()}` }); } catch (e) { toast(e.message); }
    };
    const u = el('button', { className: 'ghost small tl-undo', textContent: idx === 0 ? 'Latest' : 'Undo back to here', disabled: idx === 0 });
    if (idx > 0) u.onclick = () => undo(ev.id, `the ${idx} edit(s) after this one`);
    return el('div', { className: 'tl-item' }, el('span', { className: 'tl-dot' }), main, u);
  }));
  if (events.length) {
    const all = el('button', { className: 'ghost small danger', textContent: 'Undo everything in this session' });
    all.onclick = () => undo('start', `all ${events.length} edit(s) in this session`);
    list.append(all);
  } else list.append(el('p', { className: 'note', textContent: 'No edits yet in this tab.' }));
}

// ---------- snippets

let snippets = [];
let snipSel = 0;
let snipItems = [];

async function openSnippetPicker() {
  const s = S.sessions.get(S.active);
  if (!s) return toast('Open a session first');
  snippets = await api.snippets();
  $('#snip').hidden = false;
  $('#snipInput').value = '';
  snipSel = 0;
  renderSnipList();
  $('#snipInput').focus();
}
function closeSnippetPicker() { $('#snip').hidden = true; S.sessions.get(S.active)?.term.focus(); }

function renderSnipList() {
  const q = $('#snipInput').value.trim().toLowerCase();
  snipItems = snippets.filter((x) => !q || x.name.toLowerCase().includes(q) || x.text.toLowerCase().includes(q));
  snipSel = Math.min(snipSel, Math.max(0, snipItems.length - 1));
  $('#snipList').replaceChildren(...snipItems.map((x, i) => {
    const r = el('button', { className: 'qrow' + (i === snipSel ? ' sel' : '') },
      el('span', { className: 'qn', textContent: x.name }), el('span', { className: 'qd', textContent: x.text }));
    r.onclick = () => insertSnippet(x, false);
    return r;
  }));
  if (!snipItems.length) $('#snipList').append(el('div', { className: 'qrow muted', textContent: 'No snippets match' }));
}

function insertSnippet(x, sendNow) {
  closeSnippetPicker();
  const s = S.sessions.get(S.active);
  if (!s) return;
  s.term.paste(x.text); // bracketed paste: newlines stay in the prompt instead of submitting it
  if (sendNow) setTimeout(() => api.write(s.info.id, '\r'), 60);
  s.term.focus();
}

async function openSnippetManager() {
  snippets = await api.snippets();
  openPanel('snippets', 'Snippets', `${snippets.length} saved`);
  renderSnippetManager();
}

function renderSnippetManager() {
  $('#snippetList').replaceChildren(...snippets.map((x) => {
    const name = el('input', { value: x.name, 'aria-label': 'Snippet name' });
    const text = el('textarea', { value: x.text, rows: 3, 'aria-label': 'Snippet text' });
    const save = el('button', { className: 'ghost small', textContent: 'Save' });
    const del = el('button', { className: 'ghost small danger', textContent: 'Delete' });
    save.onclick = async () => { x.name = name.value; x.text = text.value; snippets = await api.setSnippets(snippets); toast('Saved'); };
    del.onclick = async () => { snippets = await api.setSnippets(snippets.filter((y) => y !== x)); renderSnippetManager(); };
    return el('div', { className: 'snip-edit' }, name, text, el('div', { className: 'row-actions' }, del, save));
  }));
}

// ---------- tab menu + handoff

function tabMenu(s, x, y, tabEl) {
  const iso = s.info.isolated;
  showMenu(x, y, [
    ['Rename', () => startRename(s, tabEl)],
    ['Notes', () => { activate(s.info.id); C.openNotes(); }],
    s.info.kind === 'claude' ? ['Continue in a new tab', () => handoff(s)] : null,
    iso ? null : undefined,
    iso ? ['Apply branch to working tree', () => F.isolatedAction(s, 'apply')] : null,
    iso ? ['Open a pull request', () => F.isolatedAction(s, 'pr')] : null,
    iso ? ['Discard branch', () => F.isolatedAction(s, 'discard')] : null,
    null,
    ['Close', () => closeSession(s.info.id), 'Ctrl Shift W'],
  ].filter((it) => it !== undefined).filter((it, i, a) => it !== null || (i > 0 && a[i - 1] !== null)));
}

async function handoff(s) {
  try {
    const info = await api.handoff(s.info.id, ...Object.values(estimateSize()));
    makeTerm(info);
    await activate(info.id);
    toast('New tab started with the end of the old conversation');
  } catch (e) { toast(e.message); }
}

function setupResizer() {
  const r = $('#resizer');
  const w = store.get('meta.readerWidth', 520);
  $('#reader').style.width = w + 'px';
  r.onpointerdown = (e) => {
    r.setPointerCapture(e.pointerId);
    r.classList.add('drag');
    const startX = e.clientX;
    const startW = $('#reader').getBoundingClientRect().width;
    r.onpointermove = (ev) => {
      const nw = Math.min(Math.max(320, startW + (startX - ev.clientX)), window.innerWidth - 420);
      $('#reader').style.width = nw + 'px';
    };
    r.onpointerup = () => {
      r.onpointermove = null;
      r.classList.remove('drag');
      store.set('meta.readerWidth', $('#reader').getBoundingClientRect().width);
      const s = S.sessions.get(S.active);
      try { s?.fit.fit(); } catch { /* ignore */ }
    };
  };
}

// =============================================================== quick open

let quickMode = 'open';
let quickSel = 0;
let quickItems = [];

function score(q, p) {
  // subsequence match; prefer matches in the file name and contiguous runs
  const name = base(p).toLowerCase();
  const lp = p.toLowerCase();
  if (!q) return 1;
  let i = 0, s = 0, run = 0;
  const hits = [];
  for (let j = 0; j < lp.length && i < q.length; j++) {
    if (lp[j] === q[i]) { hits.push(j); i++; run++; s += run * 2; } else run = 0;
  }
  if (i < q.length) return -1;
  if (name.includes(q)) s += 50;
  if (name.startsWith(q)) s += 30;
  return s - p.length * 0.05;
}

function openQuick(mode = 'open') {
  quickMode = mode;
  $('#quickInput').placeholder = mode === 'start' ? 'Pick a file to start Claude on' : 'Search files by name';
  $('#quick').hidden = false;
  $('#quickInput').value = '';
  renderQuick();
  $('#quickInput').focus();
}
function closeQuick() {
  $('#quick').hidden = true;
  S.sessions.get(S.active)?.term.focus();
}

function renderQuick() {
  const q = $('#quickInput').value.trim().toLowerCase();
  const recentChanged = (p) => (changeOf(p) ? 20 : 0);
  quickItems = S.files
    .map((p) => ({ p, s: score(q, p) + recentChanged(p) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map((x) => x.p);
  quickSel = Math.min(quickSel, Math.max(0, quickItems.length - 1));
  $('#quickList').replaceChildren(...quickItems.map((p, i) => {
    const c = changeOf(p);
    const r = el('button', { className: 'qrow' + (i === quickSel ? ' sel' : '') },
      el('span', { className: 'qn', textContent: base(p) }),
      el('span', { className: 'qd', textContent: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '' }),
      c ? el('span', { className: 'badge', textContent: c.kind === 'new' ? 'new' : 'changed' }) : null);
    r.onclick = () => pickQuick(p, false);
    return r;
  }));
  if (!quickItems.length) $('#quickList').append(el('div', { className: 'qrow muted', textContent: 'No matching files' }));
  $('#quickList').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

function pickQuick(p, alt) {
  closeQuick();
  if (quickMode === 'start') return startOnFile(p);
  if (alt) return mention(p);
  openFile(p);
}

// =============================================================== menus

function showMenu(x, y, items) {
  const m = $('#menu');
  m.replaceChildren(...items.map((it) => {
    if (!it) return el('hr');
    const [label, fn, key] = it;
    const b = el('button', {}, el('span', { textContent: label }), key ? el('span', { className: 'k', textContent: key }) : null);
    b.onclick = () => { hideMenu(); fn(); };
    return b;
  }));
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  m.querySelector('button')?.focus();
}
function hideMenu() { $('#menu').hidden = true; }

function projectMenu() {
  const r = $('#projectBtn').getBoundingClientRect();
  showMenu(r.left, r.bottom + 4, [
    ...S.recent.slice(0, 8).map((p) => [base(p), () => enterProject(p), p === S.project ? '●' : '']),
    null,
    ['Open folder…', pickFolder, ''],
  ]);
}

function newMenu() {
  const r = $('#newMenuBtn').getBoundingClientRect();
  const cur = store.get('meta.model', '');
  const pick = (m) => () => { store.set('meta.model', m); toast(`New Claude tabs use ${m || "Claude's default model"}`); };
  showMenu(r.left, r.bottom + 4, [
    ['New Claude session', () => newSession('claude'), 'Ctrl T'],
    ['New isolated session (own branch)', () => F.newIsolated(), ''],
    ['Start Claude on a file…', () => openQuick('start'), ''],
    ['New PowerShell', () => newSession('shell'), 'Ctrl Shift T'],
    null,
    ...[['', 'Default model'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
      .map(([m, label]) => [`New tabs: ${label}`, pick(m), cur === m ? '●' : '']),
  ]);
}

// =============================================================== tokens

function renderTokens() {
  const t = S.tokens;
  if (!t) return;
  $('#sbTokens').textContent = `today ${fmt(t.today.total)} tok · last 5h ${fmt(t.window5h.total)}`;
  const active = S.sessions.get(S.active);
  const mine = active ? t.bySession[active.info.claudeId] : null;
  // The inspector shows this session's usage; the sidebar footer carries the overall totals.
  const rows = mine ? [
    ['Tokens', mine.total, null],
    ['Output', mine.output, null],
    ['Cache reads today', t.today.cacheRead, null],
  ] : [];
  // No session usage (e.g. a PowerShell tab): hide the block rather than show a global figure.
  $('#tokenPanel').previousElementSibling.hidden = !rows.length;
  $('#tokenPanel').replaceChildren(...rows.flatMap(([k, v, sub]) => [
    el('span', {}, k, sub ? el('span', { className: 'sub', textContent: `· ${sub}` }) : null),
    el('span', { className: 'v', textContent: fmt(v) }),
  ]));
  // Usage under the sidebar. Plain numbers: Claude doesn't publish the plan's limit, so a
  // percentage bar would be invented.
  $('#sideMeter').replaceChildren(
    el('span', { textContent: 'Last 5h' }), el('b', { textContent: fmt(t.window5h.total) }),
    el('span', { className: 'spacer' }),
    el('span', { textContent: 'Today' }), el('b', { textContent: fmt(t.today.total) }));
  $('#sideMeter').title = 'Tokens from Claude\'s own logs: input + output + cache writes';
  renderInspector();
}

async function refreshTokens() {
  try { S.tokens = await api.tokens(); renderTokens(); renderSessions(); } catch { /* ignore */ }
}

// =============================================================== projects

async function pickFolder() {
  const p = await api.openFolder();
  if (p) enterProject(p, true);
}

async function enterProject(dir, alreadySet = false) {
  if (!alreadySet) await api.setProject(dir);
  const st = await api.state();
  S.project = st.project;
  S.recent = st.recent;
  $('#start').hidden = true;
  $('#projectName').textContent = base(S.project);
  S.files = await api.listFiles();
  S.changed = new Map();
  showReader(false);
  renderTree();
  for (const info of st.sessions) if (!S.sessions.has(info.id)) makeTerm(info);
  for (const x of S.sessions.values()) x.el.hidden = true;
  S.active = null;
  const want = st.active[S.project];
  const list = projectSessions();
  const target = list.find((s) => s.info.id === want) || list[0];
  renderSessions();
  renderQueue();
  refreshGit();
  F.renderScripts();
  D.projectEntered().then(renderTree);
  X.projectEntered();
  if (target) activate(target.info.id);
  else { $('#noSession').hidden = false; renderChanges(); }
}

function showStart(recent) {
  $('#start').hidden = false;
  $('#projectName').textContent = 'No folder';
  $('#recentList').replaceChildren(...recent.map((p) => {
    const b = el('button', {}, el('span', { textContent: base(p) }), el('span', { className: 'rp', textContent: p }));
    b.onclick = () => enterProject(p);
    return b;
  }));
  if (recent.length) $('#recentList').prepend(el('div', { className: 'side-head', textContent: 'Recent' }));
}

// =============================================================== wiring

const compact = () => window.innerWidth <= 900;
const refit = () => requestAnimationFrame(() => { try { S.sessions.get(S.active)?.fit.fit(); } catch { /* ignore */ } });

function toggleSidebar() {
  // Half-screen: the sidebar is already a strip of status tiles, so Ctrl+B opens it as an overlay.
  if (compact()) document.body.classList.toggle('side-overlay');
  else $('#sidebar').classList.toggle('hidden');
  refit();
}

function setSideView(view) {
  for (const b of $('#sideSeg').children) b.classList.toggle('on', b.dataset.view === view);
  for (const v of document.querySelectorAll('#sidebar .side-view')) v.hidden = v.dataset.view !== view;
  store.set('meta.sideView', view);
  if ($('#sidebar').classList.contains('hidden')) { $('#sidebar').classList.remove('hidden'); refit(); }
  if (compact()) document.body.classList.toggle('side-overlay', view !== 'sessions' || !document.body.classList.contains('side-overlay'));
}

function toggleInspector() {
  if (window.innerWidth <= 1280) document.body.classList.toggle('insp-on');
  else document.body.classList.toggle('insp-off');
  $('#inspToggle').classList.toggle('on', !document.body.classList.contains('insp-off'));
  refit();
}

function renameActive() {
  const s = S.sessions.get(S.active);
  const nm = $('#sessHead .nm');
  if (s && nm) startRename(s, nm);
}

function onKey(e) {
  if (F.pickerKey(e)) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'F11') { e.preventDefault(); return F.toggleFocus(); }
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); return F.openPalette(); }
  // Ctrl+I is Tab inside a terminal, so only take it when focus is in the reader.
  if (e.ctrlKey && e.key.toLowerCase() === 'i' && !e.target.closest?.('.term') && !$('#reader').hidden) {
    e.preventDefault();
    return F.askAboutReaderSelection();
  }
  if (!$('#quick').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); return closeQuick(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); quickSel = Math.min(quickSel + 1, quickItems.length - 1); return renderQuick(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); quickSel = Math.max(quickSel - 1, 0); return renderQuick(); }
    if (e.key === 'Enter') { e.preventDefault(); if (quickItems[quickSel]) pickQuick(quickItems[quickSel], e.altKey); return; }
  }
  if (!$('#snip').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); return closeSnippetPicker(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); snipSel = Math.min(snipSel + 1, snipItems.length - 1); return renderSnipList(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); snipSel = Math.max(snipSel - 1, 0); return renderSnipList(); }
    if (e.key === 'Enter') { e.preventDefault(); if (snipItems[snipSel]) insertSnippet(snipItems[snipSel], e.ctrlKey); return; }
  }
  if (!$('#menu').hidden && e.key === 'Escape') return hideMenu();
  if (!isAppShortcut(e)) return;
  e.preventDefault();
  e.stopPropagation();
  const k = e.key.toLowerCase();
  const list = projectSessions();
  if (e.shiftKey && k === 'f') return S.project && openSearch();
  if (e.shiftKey && k === 'g') return S.project && openGit();
  if (e.shiftKey && k === 'p') return openSnippetPicker();
  if (e.shiftKey && k === 'h') return C.openHistory();
  if (e.shiftKey && k === ' ') return X.voice();
  if (e.shiftKey && k === 'i') return toggleInspector();
  if (k === 'j') return nextNeeding();
  if (k === 't') return newSession(e.shiftKey ? 'shell' : 'claude');
  if (k === 'w') return S.active && closeSession(S.active);
  if (k === 'p') return S.project && openQuick('open');
  if (k === 'b') return toggleSidebar();
  if (k === '\\') { if (S.open) return showReader($('#reader').hidden); return S.project && openQuick('open'); }
  if (k === 'tab') {
    const i = list.findIndex((s) => s.info.id === S.active);
    const n = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
    return n && activate(n.info.id);
  }
  if (/^[1-9]$/.test(k)) { const n = list[Number(k) - 1]; return n && activate(n.info.id); }
}

// A new machine may lack the tools Tando drives. Say what's missing and why, on both empty screens.
const SETUP = [
  ['claude', 'Claude Code', 'runs every session', 'https://claude.com/claude-code'],
  ['node', 'Node.js', 'reports each session\'s status', 'https://nodejs.org/en/download'],
  ['git', 'Git', 'powers changes, isolated sessions and source control', 'https://git-scm.com/downloads/win'],
];
async function renderSetup() {
  let have;
  try { have = await api.setupCheck(); } catch { return; }
  const missing = SETUP.filter(([k]) => !have[k]);
  for (const ul of document.querySelectorAll('[data-setup]')) {
    ul.hidden = !missing.length;
    ul.replaceChildren(...missing.map(([, name, why, url]) => el('li', {},
      el('span', { className: 'setup-dot', ariaHidden: 'true' }),
      el('span', {}, el('b', { textContent: `${name} not found` }), ` · it ${why}. `),
      el('a', { href: url, target: '_blank', textContent: 'Install' }))));
    if (missing.length) ul.prepend(el('li', { className: 'setup-head', textContent: 'Before you start' }));
  }
}

async function boot() {
  // xterm measures the font when a terminal opens, so make sure the bundled mono face is ready.
  try { await Promise.all([document.fonts.load('13px "JetBrains Mono Variable"'), document.fonts.load('13px "Inter Variable"')]); } catch { /* fall back to system fonts */ }
  // Re-measure every terminal once all faces are in, so rows never overflow into the footer.
  document.fonts.ready.then(() => { for (const s of S.sessions.values()) { try { if (s.term.element) { s.term.options.fontFamily = s.term.options.fontFamily; s.fit.fit(); } } catch { /* ignore */ } } });
  F = initFeatures({
    S, api, $, el, toast, store, base,
    newSession, openQuick, openSearch, openGit, openSnippetPicker, openSnippetManager, openTimeline, openQueue,
    toggleSidebar, pickFolder, enterProject, openFile, renameActive, handoff, closeSession, dropSession,
    makeTerm, activate, estimateSize, projectSessions, openPanel, codeEditor: () => codeEditor,
    extraCommands: () => [...C.commands(), ...D.commands(), ...X.commands()],
  });
  C = initContent({
    S, api, $, el, toast, store, base, F,
    openFile, openPanel, openQuick, showReader, activate, projectSessions, renderMarkdown,
    codeEditor: () => codeEditor, baseTermTheme: THEME,
  });
  D = initDevtools({ S, api, $, el, toast, F, C, openPanel, openFile, renderTree, enterProject, newSession });
  X = initExtras({ S, api, $, el, toast, F, C, base, openPanel, showReader, newSession, activate });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', (e) => { if (!$('#menu').hidden && !$('#menu').contains(e.target)) hideMenu(); });
  $('#newClaude').onclick = () => newSession('claude');
  $('#emptyNew').onclick = () => newSession('claude');
  $('#emptyIsolated').onclick = () => F.newIsolated?.() ?? F.openPalette();
  $('#sideToggle').onclick = toggleSidebar;
  $('#inspToggle').onclick = toggleInspector;
  $('#inspToggle').classList.add('on');
  for (const b of $('#sideSeg').children) b.onclick = () => setSideView(b.dataset.view);
  setSideView(store.get('meta.sideView', 'sessions'));
  document.body.classList.remove('side-overlay');
  $('#actAllow').onclick = () => answer('1');
  $('#actAlways').onclick = () => answer('2');
  $('#actDeny').onclick = () => answer('\x1b');
  $('#actNext').onclick = nextNeeding;
  $('#actOpen').onclick = () => S.project && openQuick('open');
  $('#actPalette').onclick = () => F.openPalette();
  // Clicking a session in the half-screen overlay closes the overlay again.
  $('#sessionList').addEventListener('click', (e) => { if (compact() && e.target.closest('.srow')) document.body.classList.remove('side-overlay'); });
  window.addEventListener('resize', () => { if (!compact()) document.body.classList.remove('side-overlay'); });
  $('#newMenuBtn').onclick = newMenu;
  $('#projectBtn').onclick = projectMenu;
  $('#openFolder').onclick = pickFolder;
  $('#searchBtn').onclick = () => S.project && openQuick('open');
  $('#closeReader').onclick = async () => { if (await C.stopEdit()) showReader(false); };
  $('#editBtn').onclick = () => C.startEdit();
  $('#doneBtn').onclick = () => C.stopEdit();
  $('#pdfBtn').onclick = () => C.exportPdf();
  $('#mentionBtn').onclick = () => S.open && mention(S.open.path);
  $('#quickInput').oninput = () => { quickSel = 0; renderQuick(); };
  $('#quick').onclick = (e) => { if (e.target === $('#quick')) closeQuick(); };
  for (const b of $('#viewToggle').children) {
    b.onclick = () => { if (S.open) { S.open.mode = b.dataset.mode; openFile(S.open.path); } };
  }
  setupResizer();

  api.onData(({ id, data }) => { const s = S.sessions.get(id); if (s?.attached) { s.term.write(data); F.ptyData(id, data); } });
  api.onExit(({ id, exitCode, asleep }) => {
    const s = S.sessions.get(id);
    if (!s) return;
    s.attached = false;
    s.info.running = false;
    s.info.status = 'paused';
    s.info.asleep = !!asleep;
    s.term.write(asleep
      ? '\r\n\x1b[90m[asleep to save memory. Press a key or click the tab to wake it: the conversation resumes]\x1b[0m\r\n'
      : `\r\n\x1b[90m[session ended${exitCode ? ` (exit ${exitCode})` : ''}. Click the tab or press a key to resume]\x1b[0m\r\n`);
    const once = s.term.onData(() => { once.dispose(); s.term.reset(); attach(s); });
    renderSessions();
  });
  api.onStatus(({ id, status, message }) => {
    const s = S.sessions.get(id);
    if (!s) return;
    const prev = s.info.status;
    s.info.status = status;
    s.info.statusMsg = status === 'needs' ? String(message || '') : '';
    if (status !== 'paused') { s.info.running = true; s.info.asleep = false; }
    F.status(id, status, prev);
    X.statusChanged();
    if (status === 'done' && id === S.active) C.renderStats();
    renderSessions();
  });
  api.onFocusSession((id) => {
    const s = S.sessions.get(id);
    if (!s) return;
    if (s.info.project !== S.project) enterProject(s.info.project).then(() => activate(id));
    else activate(id);
  });
  api.onFsChanged(({ files, touched, created }) => {
    S.files = files;
    const now = Date.now();
    for (const p of touched) S.changed.set(p, { kind: created.includes(p) || S.changed.get(p)?.kind === 'new' ? 'new' : 'changed', at: now });
    renderTree();
    const viewing = S.open && (S.open.mode === 'read' || S.open.mode === 'source');
    if (viewing && touched.includes(S.open.path)) openFile(S.open.path, { keepScroll: true });
    if (C.isEditing() && touched.includes(C.editingPath())) toast(`${C.editingPath()} changed on disk. Your editor copy is kept; saving overwrites it.`);
    if (!$('#quick').hidden) renderQuick();
    scheduleChanges();
    scheduleGit();
    X.filesChanged(touched);
  });
  api.onTokens((t) => { S.tokens = t; renderTokens(); });
  api.onProjectOpened((dir) => { enterProject(dir, true); });
  api.onAppError((msg) => toast(`Something went wrong (logged to error.log): ${msg}`));
  api.onChanges(({ id }) => { if (id === S.active) { scheduleChanges(); renderTimeline(); } });
  api.onQueue((q) => { queue = q; renderQueue(); });

  $('#openQueue').onclick = openQueue;
  $('#codeBtn').onclick = () => S.open?.path && F.openInCode(S.open.path);
  $('#paletteBtn').onclick = () => F.openPalette();
  $('#openGit').onclick = openGit;
  $('#openTimeline').onclick = openTimeline;
  $('#searchInput').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); };
  for (const b of document.querySelectorAll('#searchView .seg button')) {
    b.onclick = () => {
      searchScope = b.dataset.scope;
      for (const x of document.querySelectorAll('#searchView .seg button')) x.classList.toggle('on', x === b);
      runSearch();
      $('#searchInput').focus();
    };
  }
  $('#gitRefresh').onclick = refreshGit;
  $('#gitCommit').onclick = async () => {
    try { await D.commit($('#commitMsg').value); $('#commitMsg').value = ''; toast('Committed'); refreshGit(); } catch (e) { toast(e.message); }
  };
  $('#gitPush').onclick = async () => {
    $('#gitPush').disabled = true;
    try { await api.gitPush(); toast('Pushed'); refreshGit(); } catch (e) { toast(e.message); } finally { $('#gitPush').disabled = false; }
  };
  $('#gitSuggest').onclick = async () => {
    const b = $('#gitSuggest');
    b.disabled = true;
    b.textContent = 'Claude is writing…';
    try { $('#commitMsg').value = await api.gitSuggest(); } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Write message with Claude'; }
  };
  $('#commitMsg').onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) $('#gitCommit').click(); };
  $('#snipInput').oninput = () => { snipSel = 0; renderSnipList(); };
  $('#snip').onclick = (e) => { if (e.target === $('#snip')) closeSnippetPicker(); };
  $('#manageSnippets').onclick = () => { closeSnippetPicker(); openSnippetManager(); };
  $('#addSnippet').onclick = async () => {
    snippets = await api.setSnippets([...snippets, { name: 'New snippet', text: '' }]);
    renderSnippetManager();
    $('#snippetList').lastElementChild?.querySelector('input')?.select();
  };
  $('#queueForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      queue = await api.queueAdd({ task: $('#queueTask').value, model: $('#queueModel').value, yolo: $('#queueYolo').checked });
      $('#queueTask').value = '';
      renderQueue();
    } catch (err) { toast(err.message); }
  };
  $('#queueTask').onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) $('#queueForm').requestSubmit(); };
  $('#queueStart').onclick = () => api.queueStart();
  $('#queueStop').onclick = () => api.queueStop();

  renderSetup();
  const st = await api.state();
  S.recent = st.recent;
  if (st.project) await enterProject(st.project, true);
  else showStart(st.recent);
  refreshTokens();
  queue = await api.queue();
  renderQueue();
  setInterval(renderTree, 60_000); // let "changed" markers expire
}

boot().catch((e) => toast('Failed to start: ' + e.message));
