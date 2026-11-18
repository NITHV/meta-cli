// meta web IDE. Plain ES module, no build step. Talks to `meta serve`:
// REST for actions, Server-Sent Events for live run updates.

const VS = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
};

const state = {
  files: [],
  open: [],            // open tab paths
  active: null,        // active tab path
  models: new Map(),   // path -> monaco model
  saved: new Map(),    // path -> alternativeVersionId at last save/load
  runs: new Map(),     // id -> run row
  events: new Map(),   // id -> events[] (only for runs we've loaded or seen start)
  selected: null,      // selected run id
  diffModels: [],
  followNext: false,
};
let monaco, editor, diffEditor;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-meta': '1' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const label = (r) => r.agent + (r.model ? ':' + r.model : '');

/** A readable one-line title: skip code blocks, "In file:lines:" refs and the context note. */
function runTitle(task) {
  const lines = task.replace(/```[\s\S]*?```/g, '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^In \S+:\d+(-\d+)?:$/.test(l) && !l.startsWith('(Context:'));
  return lines[0] || task.split('\n')[0];
}

// ---------- info + agents ----------

async function loadInfo() {
  const info = await api('/api/info');
  $('#repo').textContent = info.repo;
  $('#head').textContent = '@ ' + info.head;
  $('#dirtyNote').hidden = !info.dirty;
  return info;
}

function renderAgents(agents) {
  const options = [];
  for (const a of agents) {
    if (!a.version || a.hint) continue; // not installed, or needs setup
    if (a.name === 'claude') options.push('claude', 'claude:sonnet', 'claude:opus', 'claude:haiku');
    else if (a.name === 'agy') options.push('agy:gpt-oss-120b-medium');
    else options.push(a.name);
  }
  const chosen = new Set(store.get('meta.agents', ['claude']).filter((o) => options.includes(o)));
  if (!chosen.size && options.length) chosen.add(options[0]);
  $('#agents').replaceChildren(...options.map((o) => {
    const input = el('input', { type: 'checkbox', value: o, checked: chosen.has(o) });
    input.onchange = () => {
      store.set('meta.agents', [...document.querySelectorAll('#agents input:checked')].map((i) => i.value));
      updateGo();
    };
    return el('label', { className: 'chip' }, input, o);
  }));
  if (!options.length) $('#agents').append(el('span', { className: 'muted', textContent: 'No agents ready. Run `meta agents` in a terminal.' }));
  updateGo();
}

function updateGo() {
  const n = document.querySelectorAll('#agents input:checked').length;
  $('#go').textContent = n > 1 ? `Race ${n} agents` : 'Run';
  $('#go').disabled = n === 0;
}

// ---------- files ----------

async function loadFiles() {
  state.files = (await api('/api/files')).files;
  renderTree();
}

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

function renderDir(node, depth, prefix) {
  const frag = document.createDocumentFragment();
  const openDirs = store.get('meta.openDirs', []);
  for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    const path = prefix + name;
    const d = el('details', { open: openDirs.includes(path) });
    const s = el('summary', { textContent: name });
    s.style.paddingLeft = `${depth * 12 + 8}px`;
    d.ontoggle = () => {
      const set = new Set(store.get('meta.openDirs', []));
      d.open ? set.add(path) : set.delete(path);
      store.set('meta.openDirs', [...set]);
    };
    d.append(s, renderDir(child, depth + 1, path + '/'));
    frag.append(d);
  }
  for (const f of node.files.sort()) {
    const b = el('button', { className: 'file', textContent: f.split('/').pop(), title: f });
    b.dataset.path = f;
    b.style.paddingLeft = `${depth * 12 + 22}px`;
    b.onclick = () => openFile(f);
    frag.append(b);
  }
  return frag;
}

function renderTree() {
  $('#tree').replaceChildren(renderDir(buildTree(state.files), 0, ''));
  highlightTree();
}

function highlightTree() {
  for (const b of document.querySelectorAll('#tree .file')) b.classList.toggle('active', b.dataset.path === state.active);
}

// ---------- editor ----------

function loadMonaco() {
  return new Promise((resolve) => {
    // Workers must be same-origin; a data: URL bootstraps them from the CDN.
    window.MonacoEnvironment = {
      getWorkerUrl: () => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(
        `self.MonacoEnvironment={baseUrl:'${VS}/../'};importScripts('${VS}/base/worker/workerMain.js');`),
    };
    window.require.config({ paths: { vs: VS } });
    window.require(['vs/editor/editor.main'], () => {
      monaco = window.monaco;
      const dark = matchMedia('(prefers-color-scheme: dark)');
      const theme = () => monaco.editor.setTheme(dark.matches ? 'vs-dark' : 'vs');
      const common = { automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false };
      editor = monaco.editor.create($('#editor'), common);
      diffEditor = monaco.editor.createDiffEditor($('#diff'), { ...common, readOnly: true, renderSideBySide: innerWidth > 900 });
      theme();
      dark.addEventListener('change', theme);
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
      editor.addAction({
        id: 'meta.ask',
        label: 'Ask agent about selection',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
        contextMenuGroupId: 'navigation',
        run: askAboutSelection,
      });
      editor.onDidChangeModelContent(renderTabs);
      resolve();
    });
  });
}

function showEditor() {
  $('#diff').hidden = true;
  $('#diffbar').hidden = true;
  $('#editor').hidden = !state.active; // no file open: show the hint, not an empty editor
  $('#tabs').hidden = false;
  $('#empty').hidden = !!state.active;
}

const isDirty = (p) => state.models.has(p) && state.models.get(p).getAlternativeVersionId() !== state.saved.get(p);

async function openFile(path) {
  if (!monaco) return toast('Editor is still loading…');
  let model = state.models.get(path);
  if (!model) {
    let r;
    try { r = await api('/api/file?path=' + encodeURIComponent(path)); } catch (e) { return toast(e.message); }
    if (r.binary) return toast(`${path} is binary or too large to open`);
    model = monaco.editor.createModel(r.content, undefined, monaco.Uri.file('/' + path));
    state.models.set(path, model);
    state.saved.set(path, model.getAlternativeVersionId());
  }
  if (!state.open.includes(path)) state.open.push(path);
  state.active = path;
  editor.setModel(model);
  showEditor();
  renderTabs();
  highlightTree();
  editor.focus();
}

function closeTab(path) {
  if (isDirty(path) && !confirm(`${path} has unsaved changes. Close anyway?`)) return;
  state.open = state.open.filter((p) => p !== path);
  state.models.get(path)?.dispose();
  state.models.delete(path);
  state.saved.delete(path);
  if (state.active === path) {
    state.active = state.open.at(-1) ?? null;
    editor.setModel(state.active ? state.models.get(state.active) : null);
  }
  showEditor();
  renderTabs();
  highlightTree();
}

function renderTabs() {
  $('#tabs').replaceChildren(...state.open.map((p) => {
    const x = el('span', { className: 'x', textContent: '×', title: 'Close' });
    x.onclick = (e) => { e.stopPropagation(); closeTab(p); };
    const t = el('button', { className: 'tab' + (p === state.active ? ' active' : ''), title: p },
      p.split('/').pop() + (isDirty(p) ? ' •' : ''), x);
    t.onclick = () => openFile(p);
    return t;
  }));
}

async function saveActive() {
  const p = state.active;
  if (!p) return;
  const m = state.models.get(p);
  try {
    await api('/api/file', { method: 'PUT', body: { path: p, content: m.getValue() } });
  } catch (e) {
    return toast('Save failed: ' + e.message);
  }
  state.saved.set(p, m.getAlternativeVersionId());
  renderTabs();
  toast('Saved ' + p);
  loadInfo();
}

/** Reload open files that changed on disk (e.g. after Apply), unless they have unsaved edits. */
async function reloadOpenFiles() {
  for (const p of state.open) {
    if (isDirty(p)) continue;
    try {
      const r = await api('/api/file?path=' + encodeURIComponent(p));
      const m = state.models.get(p);
      if (!r.binary && m.getValue() !== r.content) {
        m.setValue(r.content);
        state.saved.set(p, m.getAlternativeVersionId());
      }
    } catch { /* file deleted: leave the tab as is */ }
  }
  renderTabs();
}

function askAboutSelection() {
  const m = editor.getModel();
  if (!m || !state.active) return;
  const sel = editor.getSelection();
  const text = m.getValueInRange(sel);
  const where = sel.isEmpty()
    ? `${state.active}:${sel.startLineNumber}`
    : `${state.active}:${sel.startLineNumber}-${sel.endLineNumber}`;
  const box = $('#task');
  const snippet = text ? `In ${where}:\n\`\`\`\n${text}\n\`\`\`\n` : `In ${where}: `;
  box.value = (box.value.trim() ? box.value.trimEnd() + '\n\n' : '') + snippet;
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

// ---------- runs ----------

async function loadRuns() {
  for (const r of (await api('/api/runs')).runs) state.runs.set(r.id, r);
  renderRuns();
}

function renderRuns() {
  const runs = [...state.runs.values()].sort((a, b) => b.started_at - a.started_at).slice(0, 100);
  $('#runs').replaceChildren(...runs.map((r) => {
    const b = el('button', { className: 'runitem' + (r.id === state.selected ? ' active' : ''), title: r.task },
      el('span', { className: 'status ' + r.status, title: r.status }),
      el('span', { className: 'task', textContent: runTitle(r.task) }),
      el('span', { className: 'meta', textContent: ago(r.started_at) }));
    b.onclick = () => selectRun(r.id);
    return b;
  }));
  if (!runs.length) $('#runs').append(el('p', { className: 'muted', style: 'padding: 0 12px', textContent: 'No runs yet.' }));
}

async function selectRun(id) {
  state.selected = id;
  if (!state.events.has(id)) {
    try {
      const r = await api('/api/runs/' + id);
      state.runs.set(id, r.run);
      state.events.set(id, r.events);
    } catch (e) {
      return toast(e.message);
    }
  }
  renderRuns();
  renderRunView();
}

function eventNode(ev) {
  switch (ev.kind) {
    case 'text': return el('div', { className: 'ev-text', textContent: ev.text.trim() });
    case 'tool': return el('div', { className: 'ev-tool', textContent: `→ ${ev.name} ${ev.detail ?? ''}`, title: ev.detail ?? '' });
    case 'tool_result': return ev.ok ? null : el('div', { className: 'ev-err', textContent: '✗ ' + ev.preview });
    case 'log': return el('div', { className: 'ev-log', textContent: ev.text });
    case 'done': {
      const bits = [ev.ok ? 'finished' : 'failed', ev.turns != null && `${ev.turns} turns`, ev.durationMs != null && `${(ev.durationMs / 1000).toFixed(1)}s`];
      return el('div', { className: 'ev-done', textContent: bits.filter(Boolean).join(' · ') });
    }
    case 'start': return el('div', { className: 'ev-log', textContent: `started${ev.model ? ' · ' + ev.model : ''}` });
    default: return null;
  }
}

function renderRunView() {
  const v = $('#runview');
  const run = state.runs.get(state.selected);
  if (!run) return v.replaceChildren();

  const actions = el('div', { className: 'rv-actions' });
  const finished = ['done', 'failed', 'cancelled'].includes(run.status);
  if (finished && run.files_changed > 0) {
    const review = el('button', { className: 'ghost', textContent: `Review ${run.files_changed} file(s)` });
    review.onclick = () => showChanges(run.id);
    const apply = el('button', { className: 'primary', textContent: 'Apply' });
    apply.onclick = () => act(run.id, 'apply');
    actions.append(review, apply);
  }
  if (finished) {
    const discard = el('button', { className: 'ghost', textContent: 'Discard' });
    discard.onclick = () => act(run.id, 'discard');
    actions.append(discard);
  }

  const head = el('div', { className: 'rv-head' },
    el('div', { className: 'rv-title' }, el('span', { className: 'status ' + run.status }), `${label(run)} · ${run.status}`),
    el('div', { className: 'rv-task', textContent: run.task }),
    actions,
    el('div', { className: 'rv-files', id: 'rvFiles' }));
  const body = el('div', { id: 'rvEvents', className: 'rv-events' });
  for (const ev of state.events.get(run.id) ?? []) { const n = eventNode(ev); if (n) body.append(n); }
  v.replaceChildren(head, body);
  v.scrollTop = v.scrollHeight;
}

function appendEvent(id, ev) {
  if (!state.events.has(id)) return;
  state.events.get(id).push(ev);
  if (id !== state.selected) return;
  const n = eventNode(ev);
  if (!n) return;
  const v = $('#runview');
  const atBottom = v.scrollHeight - v.scrollTop - v.clientHeight < 40;
  $('#rvEvents')?.append(n);
  if (atBottom) v.scrollTop = v.scrollHeight;
}

async function act(id, action) {
  try {
    const r = await api(`/api/runs/${id}/${action}`, { method: 'POST' });
    if (action === 'apply') {
      toast(`Applied. Changes are staged: review and commit with git.${r.rivals?.length ? ` ${r.rivals.length} other race run(s) still open.` : ''}`);
      showEditor();
    } else {
      toast('Discarded');
    }
  } catch (e) {
    toast(e.message);
  }
}

async function showChanges(id) {
  let r;
  try { r = await api(`/api/runs/${id}/diff`); } catch (e) { return toast(e.message); }
  if (!r.files.length) return toast('No changes');
  $('#rvFiles').replaceChildren(...r.files.map((f) => {
    const b = el('button', { textContent: f.path });
    b.onclick = () => showDiff(id, f);
    return b;
  }));
  showDiff(id, r.files[0]);
}

function showDiff(id, f) {
  if (!monaco) return toast('Editor is still loading…');
  for (const m of state.diffModels) m.dispose();
  const uri = (side) => monaco.Uri.from({ scheme: 'meta-' + side, path: `/${id}/${f.path}` });
  const original = monaco.editor.createModel(f.original, undefined, uri('a'));
  const modified = monaco.editor.createModel(f.modified, undefined, uri('b'));
  state.diffModels = [original, modified];
  diffEditor.setModel({ original, modified });
  $('#editor').hidden = true;
  $('#tabs').hidden = true;
  $('#empty').hidden = true;
  $('#diff').hidden = false;
  $('#diffbar').hidden = false;
  $('#diffTitle').textContent = `${f.path} · run ${id}`;
}

// ---------- ask ----------

async function submit(e) {
  e.preventDefault();
  let task = $('#task').value.trim();
  if (!task) return $('#task').focus();
  const agents = [...document.querySelectorAll('#agents input:checked')].map((i) => i.value);
  if ($('#withFile').checked && state.active && !task.includes(state.active)) {
    task += `\n\n(Context: I have ${state.active} open in my editor.)`;
  }
  $('#go').disabled = true;
  // Set before the POST: the server's "run started" event can arrive before the POST response.
  state.followNext = true;
  try {
    await api('/api/runs', { method: 'POST', body: { task, agents, yolo: $('#yolo').checked } });
    $('#task').value = '';
  } catch (err) {
    state.followNext = false;
    toast(err.message);
  } finally {
    updateGo();
  }
}

// ---------- live updates ----------

function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('#conn').classList.add('on'); loadRuns(); };
  es.onerror = () => $('#conn').classList.remove('on'); // EventSource reconnects by itself
  es.addEventListener('run', (m) => {
    const run = JSON.parse(m.data);
    const isNew = !state.runs.has(run.id);
    state.runs.set(run.id, run);
    if (isNew && run.status === 'running') state.events.set(run.id, []);
    if (state.followNext && run.status === 'running') {
      state.followNext = false;
      state.selected = run.id;
    }
    renderRuns();
    if (run.id === state.selected) renderRunView();
  });
  es.addEventListener('ev', (m) => {
    const { id, ev } = JSON.parse(m.data);
    appendEvent(id, ev);
  });
  es.addEventListener('files', async () => {
    await loadFiles();
    await reloadOpenFiles();
    loadInfo();
  });
  es.addEventListener('toast', (m) => toast(JSON.parse(m.data).message));
}

// ---------- boot ----------

async function main() {
  $('#ask').addEventListener('submit', submit);
  $('#task').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
  });
  $('#refresh').onclick = () => loadFiles();
  $('#backToEditor').onclick = showEditor;
  window.addEventListener('beforeunload', (e) => {
    if (state.open.some(isDirty)) e.preventDefault();
  });

  const info = await loadInfo();
  renderAgents(info.agents);
  await Promise.all([loadFiles(), loadRuns()]);
  connect();
  await loadMonaco();
  showEditor();
}

main().catch((e) => toast('Failed to start: ' + e.message));
