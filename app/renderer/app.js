// meta IDE window. Everything privileged goes through window.meta (preload.js).
const api = window.meta;
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
  background: '#0E0F12', foreground: '#D4D8E1', cursor: '#F28C4B', cursorAccent: '#0E0F12',
  selectionBackground: '#3A2A1E', black: '#1E2128', red: '#F06A6A', green: '#4ECB8F', yellow: '#E8B44A',
  blue: '#6AA8FF', magenta: '#C792EA', cyan: '#5FD4D4', white: '#D4D8E1', brightBlack: '#6E7686',
  brightRed: '#FF8A8A', brightGreen: '#7EE0AE', brightYellow: '#F5CC72', brightBlue: '#94C0FF',
  brightMagenta: '#DDB0F5', brightCyan: '#8BE6E6', brightWhite: '#FFFFFF',
};

function isAppShortcut(e) {
  if (!e.ctrlKey || e.altKey) return false;
  const k = e.key.toLowerCase();
  if (e.shiftKey) return k === 't' || k === 'w';
  return k === 't' || k === 'p' || k === 'b' || k === '\\' || k === 'tab' || /^[1-9]$/.test(k);
}

function makeTerm(info) {
  const node = el('div', { className: 'term', hidden: true });
  $('#terminals').append(node);
  const term = new window.Terminal({
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    theme: THEME,
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
    if (e.ctrlKey && k === 'v') { api.clipboardRead().then((t) => t && term.paste(t)); return false; }
    return true;
  });
  const s = { info, term, fit, el: node, attached: false, attaching: null };
  S.sessions.set(info.id, s);
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
  S.active = id;
  api.setActive(id);
  for (const x of S.sessions.values()) x.el.hidden = x !== s;
  $('#noSession').hidden = true;
  renderSessions();
  renderChanges();
  await attach(s);
  requestAnimationFrame(() => { try { s.fit.fit(); } catch { /* ignore */ } s.term.focus(); });
}

function estimateSize() {
  const box = $('#terminals').getBoundingClientRect();
  return { cols: Math.max(40, Math.floor((box.width - 30) / 7.7)), rows: Math.max(10, Math.floor((box.height - 20) / 17)) };
}

async function newSession(kind = 'claude', opts = {}) {
  if (!S.project) return toast('Open a folder first');
  try {
    const model = kind === 'claude' ? store.get('meta.model', '') : '';
    const info = await api.createSession({ kind, model, ...estimateSize(), ...opts });
    makeTerm(info);
    await activate(info.id);
  } catch (e) {
    toast(e.message);
  }
}

async function closeSession(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  const running = s.info.running && s.info.status !== 'paused';
  if (running && !confirm(`Close "${s.info.name}"? ${s.info.kind === 'claude' ? 'You can resume the conversation later with claude --resume.' : ''}`)) return;
  await api.closeSession(id);
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

function renderSessions() {
  const list = projectSessions();
  $('#tabs').replaceChildren(...list.map((s, i) => {
    const st = s.info.status || 'paused';
    const close = el('span', { className: 'close', title: 'Close session', textContent: '✕' });
    close.onclick = (e) => { e.stopPropagation(); closeSession(s.info.id); };
    const tok = S.tokens?.bySession?.[s.info.claudeId];
    const tab = el('button', {
      className: 'tab' + (s.info.id === S.active ? ' active' : ''),
      title: `${s.info.name} · ${STATUS_LABEL[st]}${tok ? ` · ${fmt(tok.total)} tokens` : ''}${i < 9 ? ` · Ctrl+${i + 1}` : ''}\nDouble-click to rename`,
    },
    el('span', { className: 'dot ' + st }),
    el('span', { textContent: s.info.kind === 'shell' ? `⌘ ${s.info.name}` : s.info.name }),
    st === 'needs' || st === 'working' || st === 'done' ? el('span', { className: 'state ' + st, textContent: STATUS_LABEL[st] }) : null,
    close);
    tab.onclick = () => activate(s.info.id);
    tab.ondblclick = () => startRename(s, tab);
    tab.oncontextmenu = (e) => { e.preventDefault(); tabMenu(s, e.clientX, e.clientY, tab); };
    return tab;
  }));
  $('#tabs').querySelector('.active')?.scrollIntoView({ inline: 'nearest' });

  $('#sessionList').replaceChildren(...list.map((s) => {
    const st = s.info.status || 'paused';
    const r = el('button', { className: 'srow' },
      el('span', { className: 'dot ' + st }),
      el('span', { className: 'n', textContent: s.info.name }),
      el('span', { className: 't', textContent: st === 'needs' ? 'waiting' : STATUS_LABEL[st] }));
    r.onclick = () => activate(s.info.id);
    return r;
  }));
  if (!list.length) $('#sessionList').append(el('div', { className: 'row muted', textContent: 'None yet' }));
  $('#noSession').hidden = list.length > 0 && !!S.active;
  if (!S.active || !S.sessions.has(S.active)) for (const x of S.sessions.values()) x.el.hidden = true;

  const all = [...S.sessions.values()];
  const running = all.filter((s) => s.info.running && s.info.status !== 'paused').length;
  const needs = all.filter((s) => s.info.status === 'needs').length;
  $('#sbSessions').textContent = `${running} running · ${all.length} sessions`;
  $('#sbNeeds').textContent = needs ? `${needs} need${needs > 1 ? '' : 's'} you` : '';
  document.title = needs ? `(${needs}) meta` : 'meta';
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
        el('span', { className: 'chev', textContent: isOpen ? '▾' : '▸' }),
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
  $('#changedCount').textContent = n ? `${n} changed` : '';
}

function fileMenu(f, x, y) {
  showMenu(x, y, [
    ['Open', () => openFile(f)],
    ['Mention in Claude', () => mention(f)],
    ['Start Claude on this file', () => startOnFile(f)],
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
        readOnly: true, automaticLayout: true, minimap: { enabled: false }, theme: 'meta',
        fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, scrollBeyondLastLine: false,
        renderLineHighlight: 'none', domReadOnly: true,
      });
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

/** The reader shows one pane at a time: md | code | diff | queue. */
function pane(name) {
  $('#mdView').hidden = name !== 'md';
  $('#codeView').hidden = name !== 'code';
  $('#diffView').hidden = name !== 'diff';
  $('#queueView').hidden = name !== 'queue';
  $('#mentionBtn').hidden = name === 'queue';
  if (name !== 'diff') $('#revertBtn').hidden = true;
  if (name === 'diff' || name === 'queue') $('#viewToggle').hidden = true;
}

function showReader(show) {
  $('#reader').hidden = !show;
  $('#resizer').hidden = !show;
  if (!show) { S.open = null; renderTree(); }
  const s = S.sessions.get(S.active);
  requestAnimationFrame(() => { try { s?.fit.fit(); } catch { /* ignore */ } });
}

async function openFile(p, { keepScroll = false } = {}) {
  let data;
  try { data = await api.readFile(p); } catch (e) { return toast(e.message); }
  const isMd = data.html != null;
  const keep = S.open?.path === p && (S.open.mode === 'read' || S.open.mode === 'source');
  const mode = keep ? S.open.mode : (isMd ? 'read' : 'source');
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
  else await renderCode(p, data.content);
}

async function renderMarkdown(data, keepScroll) {
  const view = $('#mdView');
  const top = keepScroll ? view.scrollTop : 0;
  pane('md');
  $('#viewToggle').hidden = false;
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
    window.mermaid.initialize({
      startOnLoad: false, theme: 'dark', securityLevel: 'strict',
      themeVariables: { background: '#0E0F12', primaryColor: '#1E2128', primaryBorderColor: '#F28C4B', primaryTextColor: '#E6E8EE', lineColor: '#9AA1B2', fontFamily: 'Segoe UI, sans-serif' },
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
    readOnly: true, automaticLayout: true, minimap: { enabled: false }, theme: 'meta', renderSideBySide: false,
    fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13, scrollBeyondLastLine: false, originalEditable: false,
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
  if (!s || s.info.kind !== 'claude') { box.replaceChildren(el('div', { className: 'row muted', textContent: 'Pick a Claude tab' })); $('#changesCount').textContent = ''; return; }
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
  S.open = { path: '', mode: 'queue', isMd: false, data: null };
  $('#readerTitle').textContent = 'Queue';
  $('#readerMeta').textContent = 'runs unattended, one task at a time';
  showReader(true);
  pane('queue');
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

// ---------- tab menu + handoff

function tabMenu(s, x, y, tabEl) {
  showMenu(x, y, [
    ['Rename', () => startRename(s, tabEl)],
    s.info.kind === 'claude' ? ['Continue in a new tab', () => handoff(s)] : null,
    null,
    ['Close', () => closeSession(s.info.id), 'Ctrl Shift W'],
  ].filter((x, i, a) => x !== null || (i > 0 && a[i - 1] !== null)));
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
  const rows = [
    ['Today', t.today.total, `${t.today.replies} replies`],
    ['Last 5 hours', t.window5h.total, null],
    ['Cache reads today', t.today.cacheRead, null],
    mine ? [`This session`, mine.total, `${fmt(mine.output)} out`] : null,
  ].filter(Boolean);
  $('#tokenPanel').replaceChildren(...rows.flatMap(([k, v, sub]) => [
    el('span', {}, k, sub ? el('span', { className: 'sub', textContent: ` · ${sub}` }) : null),
    el('span', { className: 'v', textContent: fmt(v) }),
  ]));
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
  if (target) activate(target.info.id);
  else { $('#noSession').hidden = false; renderChanges(); }
}

function showStart(recent) {
  $('#start').hidden = false;
  $('#projectName').textContent = 'meta';
  $('#recentList').replaceChildren(...recent.map((p) => {
    const b = el('button', {}, el('span', { textContent: base(p) }), el('span', { className: 'rp', textContent: p }));
    b.onclick = () => enterProject(p);
    return b;
  }));
  if (recent.length) $('#recentList').prepend(el('div', { className: 'side-head', textContent: 'RECENT' }));
}

// =============================================================== wiring

function onKey(e) {
  if (!$('#quick').hidden) {
    if (e.key === 'Escape') { e.preventDefault(); return closeQuick(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); quickSel = Math.min(quickSel + 1, quickItems.length - 1); return renderQuick(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); quickSel = Math.max(quickSel - 1, 0); return renderQuick(); }
    if (e.key === 'Enter') { e.preventDefault(); if (quickItems[quickSel]) pickQuick(quickItems[quickSel], e.altKey); return; }
  }
  if (!$('#menu').hidden && e.key === 'Escape') return hideMenu();
  if (!isAppShortcut(e)) return;
  e.preventDefault();
  e.stopPropagation();
  const k = e.key.toLowerCase();
  const list = projectSessions();
  if (k === 't') return newSession(e.shiftKey ? 'shell' : 'claude');
  if (k === 'w') return S.active && closeSession(S.active);
  if (k === 'p') return S.project && openQuick('open');
  if (k === 'b') { $('#sidebar').classList.toggle('hidden'); return S.sessions.get(S.active)?.fit.fit(); }
  if (k === '\\') { if (S.open) return showReader($('#reader').hidden); return S.project && openQuick('open'); }
  if (k === 'tab') {
    const i = list.findIndex((s) => s.info.id === S.active);
    const n = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
    return n && activate(n.info.id);
  }
  if (/^[1-9]$/.test(k)) { const n = list[Number(k) - 1]; return n && activate(n.info.id); }
}

async function boot() {
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', (e) => { if (!$('#menu').hidden && !$('#menu').contains(e.target)) hideMenu(); });
  $('#newClaude').onclick = () => newSession('claude');
  $('#emptyNew').onclick = () => newSession('claude');
  $('#newMenuBtn').onclick = newMenu;
  $('#projectBtn').onclick = projectMenu;
  $('#openFolder').onclick = pickFolder;
  $('#searchBtn').onclick = () => S.project && openQuick('open');
  $('#closeReader').onclick = () => showReader(false);
  $('#mentionBtn').onclick = () => S.open && mention(S.open.path);
  $('#quickInput').oninput = () => { quickSel = 0; renderQuick(); };
  $('#quick').onclick = (e) => { if (e.target === $('#quick')) closeQuick(); };
  for (const b of $('#viewToggle').children) {
    b.onclick = () => { if (S.open) { S.open.mode = b.dataset.mode; openFile(S.open.path); } };
  }
  setupResizer();

  api.onData(({ id, data }) => { const s = S.sessions.get(id); if (s?.attached) s.term.write(data); });
  api.onExit(({ id, exitCode }) => {
    const s = S.sessions.get(id);
    if (!s) return;
    s.attached = false;
    s.info.running = false;
    s.info.status = 'paused';
    s.term.write(`\r\n\x1b[90m[session ended${exitCode ? ` (exit ${exitCode})` : ''}. Click the tab or press a key to resume]\x1b[0m\r\n`);
    const once = s.term.onData(() => { once.dispose(); s.term.reset(); attach(s); });
    renderSessions();
  });
  api.onStatus(({ id, status }) => {
    const s = S.sessions.get(id);
    if (!s) return;
    s.info.status = status;
    if (status !== 'paused') s.info.running = true;
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
    if (!$('#quick').hidden) renderQuick();
    scheduleChanges();
  });
  api.onTokens((t) => { S.tokens = t; renderTokens(); });
  api.onChanges(({ id }) => { if (id === S.active) scheduleChanges(); });
  api.onQueue((q) => { queue = q; renderQueue(); });

  $('#openQueue').onclick = openQueue;
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
