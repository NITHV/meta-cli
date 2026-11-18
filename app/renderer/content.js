// Content features: edit files with live Markdown preview, PDF export, notes per tab,
// prompt history, one prompt to many tabs, side-by-side compare, themes, layouts, stats.

const THEMES = {
  dark: {
    term: { background: '#0E0F12', foreground: '#D4D8E1', cursor: '#F28C4B', cursorAccent: '#0E0F12', selectionBackground: '#3A2A1E' },
    titlebar: ['#16181D', '#9AA1B2'], monaco: 'meta', mermaid: 'dark',
  },
  light: {
    term: {
      background: '#FBFBFC', foreground: '#1D2330', cursor: '#C2410C', cursorAccent: '#FBFBFC', selectionBackground: '#FBD9C5',
      black: '#1D2330', red: '#B91C1C', green: '#15803D', yellow: '#A16207', blue: '#1D4ED8', magenta: '#7E22CE', cyan: '#0E7490', white: '#6B7385',
      brightBlack: '#4A5263', brightRed: '#DC2626', brightGreen: '#16A34A', brightYellow: '#CA8A04', brightBlue: '#2563EB', brightMagenta: '#9333EA', brightCyan: '#0891B2', brightWhite: '#1D2330',
    },
    titlebar: ['#FFFFFF', '#4A5263'], monaco: 'meta-light', mermaid: 'default',
  },
  contrast: {
    term: { background: '#000000', foreground: '#FFFFFF', cursor: '#FFB000', cursorAccent: '#000000', selectionBackground: '#5A4400' },
    titlebar: ['#000000', '#FFFFFF'], monaco: 'hc-black', mermaid: 'dark',
  },
};

export function init(ctx) {
  const { S, api, $, el, toast, store } = ctx;
  let theme = 'dark';

  // ------------------------------------------------------------ generic text prompt

  function ask({ title, value = '', multiline = false, okLabel = 'OK' }) {
    return new Promise((resolve) => {
      const box = $('#askModal');
      $('#askTitle').textContent = title;
      const input = multiline ? el('textarea', { rows: 6, value }) : el('input', { value });
      $('#askField').replaceChildren(input);
      $('#askOk').textContent = okLabel;
      box.hidden = false;
      input.focus();
      input.select?.();
      const done = (v) => { box.hidden = true; resolve(v); S.sessions.get(S.active)?.term.focus(); };
      $('#askOk').onclick = () => done(input.value);
      $('#askCancel').onclick = () => done(null);
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') done(null);
        if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); done(input.value); }
      };
    });
  }

  // ------------------------------------------------------------ edit files (+ live Markdown preview)

  let editing = null; // { path, isMd, saved: versionId, sub }
  let previewTimer;

  async function startEdit() {
    const o = S.open;
    if (!o?.path || o.data?.binary || !['read', 'source'].includes(o.mode)) return toast('Open a text file first');
    if (o.mode === 'read') { o.mode = 'source'; await ctx.openFile(o.path); }
    const ed = ctx.codeEditor();
    ed.updateOptions({ readOnly: false, domReadOnly: false });
    S.open.mode = 'edit';
    editing = { path: o.path, isMd: o.isMd, saved: ed.getModel().getAlternativeVersionId() };
    editing.sub = ed.onDidChangeModelContent(() => { markDirty(); if (editing.isMd) schedulePreview(); });
    $('#reader').classList.toggle('split', editing.isMd);
    if (editing.isMd) {
      // Two columns need room: widen the reader for the edit, restore it after.
      editing.width = $('#reader').style.width;
      $('#reader').style.width = Math.round(Math.max(640, window.innerWidth * 0.6)) + 'px';
      $('#mdView').hidden = false;
      await refreshPreview();
    }
    $('#editBtn').hidden = true;
    $('#doneBtn').hidden = false;
    $('#viewToggle').hidden = true;
    markDirty();
    ed.focus();
  }

  function isDirty() {
    return editing && ctx.codeEditor().getModel().getAlternativeVersionId() !== editing.saved;
  }
  function markDirty() {
    if (!editing) return;
    $('#readerTitle').textContent = ctx.base(editing.path) + (isDirty() ? ' •' : '');
    $('#readerMeta').textContent = isDirty() ? 'editing · Ctrl+S to save' : 'editing · saved';
  }

  async function save() {
    if (!editing) return false;
    const ed = ctx.codeEditor();
    try {
      await api.writeFile(editing.path, ed.getValue());
      editing.saved = ed.getModel().getAlternativeVersionId();
      markDirty();
      toast('Saved ' + editing.path);
      return true;
    } catch (e) { toast('Save failed: ' + e.message); return false; }
  }

  /** Leave edit mode. Returns false if the user chose to keep editing. */
  async function stopEdit({ force = false } = {}) {
    if (!editing) return true;
    if (!force && isDirty() && !confirm(`Discard unsaved changes to ${editing.path}?`)) return false;
    const p = editing.path;
    if (editing.width !== undefined) $('#reader').style.width = editing.width;
    editing.sub.dispose();
    editing = null;
    ctx.codeEditor().updateOptions({ readOnly: true, domReadOnly: true });
    $('#reader').classList.remove('split');
    $('#doneBtn').hidden = true;
    S.open.mode = 'source';
    await ctx.openFile(p);
    return true;
  }

  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(refreshPreview, 300); }
  async function refreshPreview() {
    if (!editing?.isMd) return;
    const html = await api.renderMd(ctx.codeEditor().getValue());
    await ctx.renderMarkdown({ html }, true, true); // preview: keep scroll, don't switch panes
  }

  // ------------------------------------------------------------ export to PDF

  async function exportPdf() {
    if (!S.open?.isMd) return toast('Open a Markdown file to export it');
    if (S.open.mode !== 'read') { S.open.mode = 'read'; await ctx.openFile(S.open.path); }
    // Paper is white: redraw diagrams with Mermaid's light theme for the PDF copy.
    const copy = $('#mdView').cloneNode(true);
    const blocks = [...copy.querySelectorAll('.mermaid-src[data-src]')];
    if (blocks.length) {
      window.mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
      let n = 0;
      for (const b of blocks) {
        try { b.innerHTML = (await window.mermaid.render(`pdf${Date.now()}${n++}`, b.dataset.src)).svg; } catch { /* keep the screen version */ }
      }
      window.mermaid.initialize({ startOnLoad: false, theme: THEMES[theme].mermaid, securityLevel: 'strict' });
    }
    try {
      const out = await api.exportPdf(S.open.path, copy.innerHTML);
      if (out) toast('Saved ' + out);
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------ notes per tab

  let notesTimer;
  async function openNotes() {
    const s = S.sessions.get(S.active);
    if (!s) return toast('Pick a tab first');
    ctx.openPanel('notes', 'Notes', s.info.name);
    const ta = $('#notesText');
    ta.value = await api.notes(s.info.id);
    ta.dataset.id = s.info.id;
    ta.focus();
  }
  $('#notesText').oninput = () => {
    clearTimeout(notesTimer);
    const ta = $('#notesText');
    notesTimer = setTimeout(() => api.setNotes(ta.dataset.id, ta.value), 400); // autosave
  };
  $('#notesSend').onclick = () => {
    const s = S.sessions.get($('#notesText').dataset.id);
    const text = $('#notesText').value.trim();
    if (!s || s.info.kind !== 'claude') return toast('Notes can go to a Claude tab');
    if (!text) return toast('Notes are empty');
    s.term.paste(`My notes for this session:\n${text}\n\n`);
    ctx.activate(s.info.id);
  };

  // ------------------------------------------------------------ prompt history

  async function openHistory() {
    const s = S.sessions.get(S.active);
    if (!s || s.info.kind !== 'claude') return toast('Pick a Claude tab first');
    const list = await api.history();
    if (!list.length) return toast('No past prompts yet');
    ctx.F.openPicker({
      placeholder: `Search ${list.length} past prompts (Enter inserts into ${s.info.name})`,
      items: list.map((p) => ({
        label: p.text.split('\n')[0].slice(0, 120),
        hint: `${p.project ? ctx.base(p.project) + ' · ' : ''}${new Date(p.at).toLocaleDateString()}`,
        run: () => { s.term.paste(p.text); s.term.focus(); },
      })),
    });
  }

  // ------------------------------------------------------------ one prompt to many tabs + compare

  async function broadcast() {
    const tabs = ctx.projectSessions().filter((s) => s.info.kind === 'claude');
    if (tabs.length < 2) return toast('Open at least two Claude tabs first');
    const box = $('#broadcastModal');
    $('#broadcastTabs').replaceChildren(...tabs.map((s, i) => el('label', { className: 'chk' },
      el('input', { type: 'checkbox', value: s.info.id, checked: i < 2 }), s.info.name)));
    $('#broadcastText').value = '';
    box.hidden = false;
    $('#broadcastText').focus();
    $('#broadcastCancel').onclick = () => (box.hidden = true);
    $('#broadcastSend').onclick = async () => {
      const text = $('#broadcastText').value.trim();
      const ids = [...$('#broadcastTabs').querySelectorAll('input:checked')].map((i) => i.value);
      if (!text || !ids.length) return toast('Write a prompt and pick tabs');
      box.hidden = true;
      for (const id of ids) {
        const s = S.sessions.get(id);
        await ctx.activate(id); // attaches (wakes) the tab if needed
        s.term.paste(text);
        await new Promise((r) => setTimeout(r, 80));
        api.write(id, '\r');
      }
      if (ids.length >= 2) compare(ids[0], ids[1]);
      toast(`Sent to ${ids.length} tabs`);
    };
  }

  function compare(a, b) {
    const A = S.sessions.get(a), B = S.sessions.get(b);
    if (!A || !B) return;
    S.compare = [a, b];
    for (const x of S.sessions.values()) x.el.hidden = x !== A && x !== B;
    A.el.classList.add('left');
    B.el.classList.add('right');
    $('#terminals').classList.add('compare');
    $('#compareBar').hidden = false;
    $('#compareNames').textContent = `${A.info.name}  |  ${B.info.name}`;
    requestAnimationFrame(() => { for (const x of [A, B]) try { x.fit.fit(); } catch { /* ignore */ } });
  }
  async function pickCompare() {
    const tabs = ctx.projectSessions().filter((s) => s.info.kind === 'claude');
    if (tabs.length < 2) return toast('Open at least two Claude tabs first');
    const first = await new Promise((res) => ctx.F.openPicker({ placeholder: 'Compare: pick the left tab', items: tabs.map((s) => ({ label: s.info.name, run: () => res(s) })) }));
    const rest = tabs.filter((s) => s !== first);
    ctx.F.openPicker({ placeholder: 'Pick the right tab', items: rest.map((s) => ({ label: s.info.name, run: async () => { await ctx.activate(first.info.id); await ctx.activate(s.info.id); compare(first.info.id, s.info.id); } })) });
  }
  function stopCompare() {
    if (!S.compare) return;
    S.compare = null;
    for (const x of S.sessions.values()) x.el.classList.remove('left', 'right');
    $('#terminals').classList.remove('compare');
    $('#compareBar').hidden = true;
    for (const x of S.sessions.values()) x.el.hidden = x.info.id !== S.active;
    const s = S.sessions.get(S.active);
    requestAnimationFrame(() => { try { s?.fit.fit(); } catch { /* ignore */ } });
  }
  $('#compareClose').onclick = stopCompare;

  // ------------------------------------------------------------ themes

  function applyTheme(name) {
    theme = THEMES[name] ? name : 'dark';
    document.documentElement.dataset.theme = theme;
    const t = THEMES[theme];
    for (const s of S.sessions.values()) s.term.options.theme = { ...ctx.baseTermTheme, ...t.term };
    window.monaco?.editor.setTheme(t.monaco);
    api.titlebarTheme(...t.titlebar);
  }
  async function pickTheme() {
    ctx.F.openPicker({
      placeholder: 'Theme',
      items: [['dark', 'Dark'], ['light', 'Light'], ['contrast', 'High contrast']].map(([k, label]) => ({
        label: label + (k === theme ? '  ●' : ''),
        run: async () => { applyTheme(k); await api.setSettings({ theme: k }); },
      })),
    });
  }
  api.settings().then((s) => applyTheme(s.theme || 'dark'));

  // ------------------------------------------------------------ layouts

  const BUILTIN = {
    'Terminal only': { sidebar: false, reader: false },
    'Terminal + files': { sidebar: true, reader: false },
    'Everything': { sidebar: true, reader: true },
  };
  function currentLayout() {
    return { sidebar: !$('#sidebar').classList.contains('hidden'), reader: !$('#reader').hidden, readerWidth: $('#reader').getBoundingClientRect().width || 520 };
  }
  function applyLayout(l) {
    document.body.classList.remove('focus');
    $('#sidebar').classList.toggle('hidden', !l.sidebar);
    if (l.readerWidth) $('#reader').style.width = l.readerWidth + 'px';
    if (!l.reader) ctx.showReader(false);
    else if (S.open) ctx.showReader(true);
    else ctx.openQuick('open');
    const s = S.sessions.get(S.active);
    requestAnimationFrame(() => { try { s?.fit.fit(); } catch { /* ignore */ } });
  }
  async function pickLayout() {
    const saved = store.get('meta.layouts', {});
    ctx.F.openPicker({
      placeholder: 'Layout',
      items: [
        ...Object.entries({ ...BUILTIN, ...saved }).map(([name, l]) => ({ label: name, hint: saved[name] ? 'saved' : 'built in', run: () => applyLayout(l) })),
        { label: 'Save current layout as…', run: saveLayout },
      ],
    });
  }
  async function saveLayout() {
    const name = await ask({ title: 'Name this layout', value: 'My layout', okLabel: 'Save' });
    if (!name?.trim()) return;
    store.set('meta.layouts', { ...store.get('meta.layouts', {}), [name.trim()]: currentLayout() });
    toast(`Saved layout "${name.trim()}"`);
  }

  // ------------------------------------------------------------ per-session stats

  async function renderStats() {
    const s = S.sessions.get(S.active);
    const line = $('#statsLine');
    if (!s || s.info.kind !== 'claude') { line.textContent = ''; return; }
    const st = await api.sessionStats(s.info.claudeId).catch(() => null);
    line.textContent = st ? `${st.prompts} prompts · ${st.tools} tool calls · ${st.minutes} min` : 'No conversation yet';
  }

  // ------------------------------------------------------------ hooks

  return {
    ask,
    startEdit,
    stopEdit,
    save,
    exportPdf,
    openNotes,
    openHistory,
    broadcast,
    pickCompare,
    stopCompare,
    pickTheme,
    pickLayout,
    renderStats,
    isEditing: () => !!editing,
    editingPath: () => editing?.path,
    termTheme: () => ({ ...ctx.baseTermTheme, ...THEMES[theme].term }),
    mermaidTheme: () => THEMES[theme].mermaid,
    monacoTheme: () => THEMES[theme].monaco,
    commands: () => [
      { label: 'Edit this file', hint: 'Markdown gets a live preview', run: startEdit },
      { label: 'Export this Markdown to PDF', run: exportPdf },
      { label: 'Notes for this tab', run: openNotes },
      { label: 'Prompt history…', key: 'Ctrl Shift H', run: openHistory },
      { label: 'Send one prompt to several tabs…', run: broadcast },
      { label: 'Compare two tabs side by side…', run: pickCompare },
      S.compare ? { label: 'Stop comparing', run: stopCompare } : null,
      { label: 'Theme…', run: pickTheme },
      { label: 'Layout…', run: pickLayout },
    ].filter(Boolean),
  };
}
