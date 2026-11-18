// Window features layered on the core (app.js): command palette, focus mode, sound cues,
// clickable file:line links, image paste, error catcher, scripts, ports, isolated sessions.
// app.js passes a ctx of its functions and calls the hooks this returns.

export function init(ctx) {
  const { S, api, $, el, toast, store } = ctx;
  let settings = { sound: true, sleepMinutes: 30 };
  api.settings().then((s) => (settings = s));

  // ------------------------------------------------------------ generic picker (palette and friends)

  let pick = null; // { items, sel, onPick }
  function openPicker({ placeholder, items, onPick }) {
    pick = { all: items, items, sel: 0, onPick };
    $('#paletteInput').placeholder = placeholder;
    $('#paletteInput').value = '';
    $('#palette').hidden = false;
    renderPicker();
    $('#paletteInput').focus();
  }
  function closePicker() { $('#palette').hidden = true; pick = null; S.sessions.get(S.active)?.term.focus(); }
  function renderPicker() {
    const q = $('#paletteInput').value.trim().toLowerCase();
    pick.items = pick.all.filter((it) => !q || it.label.toLowerCase().includes(q) || (it.hint || '').toLowerCase().includes(q));
    pick.sel = Math.min(pick.sel, Math.max(0, pick.items.length - 1));
    $('#paletteList').replaceChildren(...pick.items.map((it, i) => {
      const b = el('button', { className: 'qrow' + (i === pick.sel ? ' sel' : '') },
        el('span', { className: 'qn', textContent: it.label }),
        it.hint ? el('span', { className: 'qd', textContent: it.hint }) : null,
        it.key ? el('kbd', { textContent: it.key, style: 'margin-left:auto' }) : null);
      b.onclick = () => choose(it);
      return b;
    }));
    if (!pick.items.length) $('#paletteList').append(el('div', { className: 'qrow muted', textContent: 'Nothing matches' }));
    $('#paletteList').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function choose(it) { const p = pick; closePicker(); (it.run || (() => p.onPick?.(it)))(); }
  $('#paletteInput').oninput = () => { pick.sel = 0; renderPicker(); };
  $('#palette').onclick = (e) => { if (e.target === $('#palette')) closePicker(); };

  function pickerKey(e) {
    if ($('#palette').hidden) return false;
    if (e.key === 'Escape') { closePicker(); return true; }
    if (e.key === 'ArrowDown') { pick.sel = Math.min(pick.sel + 1, pick.items.length - 1); renderPicker(); return true; }
    if (e.key === 'ArrowUp') { pick.sel = Math.max(pick.sel - 1, 0); renderPicker(); return true; }
    if (e.key === 'Enter') { if (pick.items[pick.sel]) choose(pick.items[pick.sel]); return true; }
    return false;
  }

  function commands() {
    const s = S.sessions.get(S.active);
    const cmds = [
      { label: 'New Claude session', key: 'Ctrl T', run: () => ctx.newSession('claude') },
      { label: 'New isolated Claude session', hint: 'own git branch and worktree', run: newIsolated },
      { label: 'New PowerShell', key: 'Ctrl Shift T', run: () => ctx.newSession('shell') },
      { label: 'Start Claude on a file…', run: () => ctx.openQuick('start') },
      { label: 'Open file…', key: 'Ctrl P', run: () => ctx.openQuick('open') },
      { label: 'Search files and past chats', key: 'Ctrl Shift F', run: ctx.openSearch },
      { label: 'Source control', key: 'Ctrl Shift G', run: ctx.openGit },
      { label: 'Insert a prompt snippet', key: 'Ctrl Shift P', run: ctx.openSnippetPicker },
      { label: 'Manage snippets', run: ctx.openSnippetManager },
      { label: 'Timeline of this tab', run: ctx.openTimeline },
      { label: 'Night queue', run: ctx.openQueue },
      { label: 'Ports opened by your terminals', run: openPorts },
      { label: 'Run a package.json script…', run: pickScript },
      { label: 'Toggle files panel', key: 'Ctrl B', run: () => ctx.toggleSidebar() },
      { label: 'Focus mode (terminal only)', key: 'F11', run: toggleFocus },
      { label: settings.sound ? 'Turn sound cues off' : 'Turn sound cues on', run: () => setSetting({ sound: !settings.sound }) },
      { label: `Sleep idle tabs after… (now ${settings.sleepMinutes ? settings.sleepMinutes + ' min' : 'never'})`, run: pickSleep },
      { label: 'Open folder…', run: ctx.pickFolder },
      ...S.recent.filter((p) => p !== S.project).slice(0, 6).map((p) => ({ label: `Switch to ${ctx.base(p)}`, hint: p, run: () => ctx.enterProject(p) })),
    ];
    if (S.open?.path) cmds.push({ label: `Open ${ctx.base(S.open.path)} in VS Code`, run: () => openInCode(S.open.path) });
    cmds.push(...(ctx.extraCommands?.() || []));
    if (s) {
      cmds.push({ label: `Rename "${s.info.name}"`, run: () => ctx.renameActive() });
      if (s.info.kind === 'claude') cmds.push({ label: 'Continue this tab in a new tab', run: () => ctx.handoff(s) });
      if (s.info.isolated) {
        cmds.push({ label: `Apply ${s.info.isolated.branch} to your working tree`, run: () => isolatedAction(s, 'apply') });
        cmds.push({ label: `Open a pull request for ${s.info.isolated.branch}`, run: () => isolatedAction(s, 'pr') });
        cmds.push({ label: `Discard ${s.info.isolated.branch}`, run: () => isolatedAction(s, 'discard') });
      }
      cmds.push({ label: `Close "${s.info.name}"`, key: 'Ctrl Shift W', run: () => ctx.closeSession(s.info.id) });
    }
    return cmds;
  }
  const openPalette = () => openPicker({ placeholder: 'Type a command', items: commands() });

  async function setSetting(patch) { settings = { ...settings, ...(await api.setSettings(patch)) }; toast('Saved'); }
  function pickSleep() {
    openPicker({
      placeholder: 'Stop idle Claude tabs after… (they resume when clicked)',
      items: [10, 30, 60, 120, 0].map((m) => ({ label: m ? `${m} minutes` : 'Never', run: () => setSetting({ sleepMinutes: m }) })),
    });
  }

  // ------------------------------------------------------------ focus mode

  function toggleFocus() {
    document.body.classList.toggle('focus');
    const s = S.sessions.get(S.active);
    requestAnimationFrame(() => { try { s?.fit.fit(); } catch { /* ignore */ } });
  }

  // ------------------------------------------------------------ sound cues

  let audio;
  function chime(kind) {
    if (!settings.sound) return;
    try {
      audio ??= new AudioContext();
      const notes = kind === 'needs' ? [660, 880] : [523, 659];
      notes.forEach((f, i) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const t = audio.currentTime + i * 0.12;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.connect(g).connect(audio.destination);
        o.start(t);
        o.stop(t + 0.3);
      });
    } catch { /* no audio device */ }
  }

  // ------------------------------------------------------------ clickable file:line links

  const LINK_RE = /(?:[A-Za-z]:[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.[A-Za-z][\w]{0,7}(?::\d+)?(?::\d+)?/g;
  function resolveLink(text) {
    const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(text);
    let p = m[1].replace(/\\/g, '/');
    const proj = (S.project || '').replace(/\\/g, '/');
    if (proj && p.toLowerCase().startsWith(proj.toLowerCase() + '/')) p = p.slice(proj.length + 1);
    if (p.startsWith('./')) p = p.slice(2);
    if (!S.files.includes(p)) return null;
    return { path: p, line: m[2] ? Number(m[2]) : 0 };
  }

  function termCreated(s) {
    s.term.registerLinkProvider({
      provideLinks(y, cb) {
        const line = s.term.buffer.active.getLine(y - 1)?.translateToString(true) || '';
        const links = [];
        for (const m of line.matchAll(LINK_RE)) {
          const r = resolveLink(m[0]);
          if (!r) continue;
          links.push({
            range: { start: { x: m.index + 1, y }, end: { x: m.index + m[0].length, y } },
            text: m[0],
            activate: () => ctx.openFile(r.path, { line: r.line }),
          });
        }
        cb(links.length ? links : undefined);
      },
    });
  }

  /** Inline `code` in Markdown that names a project file becomes a link to it. */
  function markdownRendered(view) {
    for (const c of view.querySelectorAll('code')) {
      if (c.closest('pre')) continue;
      const r = resolveLink(c.textContent.trim());
      if (!r) continue;
      c.classList.add('filelink');
      c.title = 'Open ' + r.path;
      c.onclick = () => ctx.openFile(r.path, { line: r.line });
    }
  }

  // ------------------------------------------------------------ clipboard: text or image

  async function paste(s) {
    const text = await api.clipboardRead();
    if (text) return s.term.paste(text);
    if (s.info.kind !== 'claude') return;
    try {
      const rel = await api.saveClipboardImage(s.info.id);
      if (rel) { s.term.paste(`@${rel} `); toast('Image saved to ' + rel); }
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------ error catcher (shell tabs)

  const ERR_RE = /\b(error|exception|traceback|failed|fatal|npm ERR!|cannot find|not recognized)\b/i;
  const errState = new Map(); // id -> timer
  function ptyData(id, data) {
    const s = S.sessions.get(id);
    if (!s || s.info.kind !== 'shell' || !ERR_RE.test(data)) return;
    clearTimeout(errState.get(id));
    errState.set(id, setTimeout(() => showErrorBar(s), 600)); // wait for the output to settle
  }
  function showErrorBar(s) {
    s.el.querySelector('.errbar')?.remove();
    const fix = el('button', { className: 'primary', textContent: 'Fix with Claude' });
    const close = el('button', { className: 'icon', textContent: '✕', 'aria-label': 'Dismiss' });
    const bar = el('div', { className: 'errbar' }, el('span', { textContent: 'Looks like that command failed.' }), fix, close);
    close.onclick = () => bar.remove();
    fix.onclick = () => {
      bar.remove();
      const buf = s.term.buffer.active;
      const lines = [];
      for (let i = Math.max(0, buf.length - 80); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
      const output = lines.join('\n').trim().slice(-6000);
      const prompt = `A command failed in my terminal. Here is the end of the output:\n\n${output}\n\nFind the cause and fix it. Explain briefly what was wrong.`;
      ctx.newSession('claude', { name: 'fix error', prompt });
    };
    s.el.append(bar);
  }

  // ------------------------------------------------------------ scripts + ports

  async function pickScript() {
    const list = await api.scripts();
    if (!list.length) return toast('No package.json scripts in this project');
    openPicker({ placeholder: 'Run a script in a new terminal', items: list.map((x) => ({ label: x.name, hint: x.cmd, run: () => runScript(x.name) })) });
  }
  async function runScript(name) {
    await ctx.newSession('shell', { name: `npm ${name}` });
    const s = S.sessions.get(S.active);
    setTimeout(() => api.write(s.info.id, `npm run ${name}\r`), 700);
  }
  async function renderScripts() {
    const box = $('#scriptList');
    const list = S.project ? await api.scripts() : [];
    $('#scriptsSection').hidden = !list.length;
    box.replaceChildren(...list.slice(0, 8).map((x) => {
      const b = el('button', { className: 'chipbtn', textContent: '▶ ' + x.name, title: x.cmd });
      b.onclick = () => runScript(x.name);
      return b;
    }));
  }

  async function openPorts() {
    ctx.openPanel('ports', 'Ports', 'servers started from your terminals');
    await renderPorts();
  }
  async function renderPorts() {
    if ($('#portsView').hidden) return;
    let ports = [];
    try { ports = await api.ports(); } catch (e) { toast(e.message); }
    $('#portList').replaceChildren(...ports.map((p) => {
      const open = el('button', { className: 'ghost small', textContent: 'Open' });
      open.onclick = () => api.openExternal(`http://localhost:${p.port}`);
      const stop = el('button', { className: 'ghost small danger', textContent: 'Stop' });
      stop.onclick = async () => {
        if (!confirm(`Stop ${p.name} (pid ${p.pid}) on port ${p.port}?`)) return;
        try { await api.killPort(p.pid); toast('Stopped'); renderPorts(); } catch (e) { toast(e.message); }
      };
      return el('div', { className: 'port-row' },
        el('span', { className: 'port', textContent: ':' + p.port }),
        el('span', { className: 'pname', textContent: `${p.name} · from ${p.session}` }),
        open, stop);
    }));
    if (!ports.length) $('#portList').append(el('p', { className: 'note', textContent: 'No servers are listening. Start one (for example npm run dev) in a terminal tab.' }));
  }
  setInterval(() => { if (!$('#portsView').hidden) renderPorts(); }, 8000);

  // ------------------------------------------------------------ isolated sessions

  async function newIsolated() {
    if (!S.project) return toast('Open a folder first');
    try {
      const info = await api.createIsolated({ name: `task ${projectCount() + 1}`, model: store.get('meta.model', ''), ...ctx.estimateSize() });
      ctx.makeTerm(info);
      await ctx.activate(info.id);
      toast(`Isolated on branch ${info.isolated.branch}`);
    } catch (e) { toast(e.message); }
  }
  const projectCount = () => ctx.projectSessions().length;

  async function isolatedAction(s, action) {
    try {
      if (action === 'apply') {
        const info = await api.isolatedInfo(s.info.id);
        if (!info?.files.length) return toast('No changes on this branch yet');
        if (!confirm(`Apply ${info.files.length} changed file(s) from ${info.branch} to your working tree? The tab closes and the branch is removed.`)) return;
        await api.isolatedApply(s.info.id);
        ctx.dropSession(s.info.id);
        toast('Applied. Changes are staged: review in Source control and commit.');
      } else if (action === 'pr') {
        toast('Pushing branch and opening a pull request…');
        const url = await api.isolatedPr(s.info.id);
        toast('Pull request opened: ' + url);
      } else if (action === 'discard') {
        if (!confirm(`Discard ${s.info.isolated.branch} and everything Claude did on it?`)) return;
        await api.isolatedDiscard(s.info.id);
        ctx.dropSession(s.info.id);
        toast('Discarded');
      }
    } catch (e) { toast(e.message); }
  }

  /** Closing an isolated tab: ask what to do with its branch. */
  function closeIsolated(s) {
    openPicker({
      placeholder: `Close "${s.info.name}": what about branch ${s.info.isolated.branch}?`,
      items: [
        { label: 'Apply its changes to my working tree', run: () => isolatedAction(s, 'apply') },
        { label: 'Open a pull request', run: () => isolatedAction(s, 'pr') },
        { label: 'Discard the branch', run: () => isolatedAction(s, 'discard') },
        { label: 'Keep the branch, just close the tab', run: () => ctx.closeSession(s.info.id, true) },
      ],
    });
  }

  // ------------------------------------------------------------ ask Claude about a selection in the reader

  function askAboutReaderSelection() {
    const s = [...S.sessions.values()].find((x) => x.info.id === S.active && x.info.kind === 'claude');
    if (!s) return toast('Open a Claude tab first');
    let text = '', where = S.open?.path || '';
    if (!$('#codeView').hidden && ctx.codeEditor()) {
      const ed = ctx.codeEditor();
      const sel = ed.getSelection();
      text = ed.getModel().getValueInRange(sel);
      if (text) where += `:${sel.startLineNumber}-${sel.endLineNumber}`;
    } else {
      text = String(window.getSelection() || '');
    }
    if (!text.trim()) return toast('Select some text in the file first');
    s.term.paste(`In ${where}:\n${text.split('\n').map((l) => '> ' + l).join('\n')}\n\n`);
    s.term.focus();
  }

  async function openInCode(rel) {
    try { await api.openInVSCode(rel, 0); } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------ hooks for app.js

  return {
    openPalette,
    openPicker,
    pickerKey,
    toggleFocus,
    termCreated,
    markdownRendered,
    paste,
    ptyData,
    renderScripts,
    newIsolated,
    closeIsolated,
    isolatedAction,
    askAboutReaderSelection,
    openInCode,
    status(id, status, prev) {
      if (prev === status) return;
      const watching = document.hasFocus() && id === S.active;
      if (!watching && (status === 'needs' || status === 'done') && prev === 'working') chime(status);
      else if (status === 'needs' && prev !== 'needs') chime('needs');
    },
    async beforeCreate() {
      const m = await api.memory();
      if (m.running >= 4 || m.freeMb < 900) toast(`Heads up: ${m.running} sessions running, ${m.freeMb} MB RAM free. Idle tabs sleep after ${settings.sleepMinutes || '∞'} min.`);
    },
  };
}
