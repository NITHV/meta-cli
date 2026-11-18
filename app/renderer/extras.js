// Final batch in the window: phone access + share links, live preview, watch mode,
// voice typing, daily recap, learning mode, and the task board.

export function init(ctx) {
  const { S, api, $, el, toast } = ctx;

  // ------------------------------------------------------------ a Markdown "document" panel

  async function showDoc(title, meta, md, actions = []) {
    ctx.openPanel('doc', title, meta);
    const html = await api.renderMd(md);
    const art = el('article', { className: 'markdown' });
    art.innerHTML = html; // rendered by markdown-it in the main process with raw HTML disabled
    $('#docBody').replaceChildren(el('div', { className: 'git-actions' }, el('span', { className: 'spacer' }), ...actions), art);
  }
  const busy = (label) => showDoc(label, '', `_${label}…_`);

  // ------------------------------------------------------------ phone access + share links

  async function openPhone() {
    const info = await api.phone();
    ctx.openPanel('phone', 'Phone access', info.on ? `on · port ${info.port}` : 'off');
    renderPhone(info);
  }
  function renderPhone(info) {
    const toggle = el('button', { className: info.on ? 'ghost' : 'primary', textContent: info.on ? 'Turn off' : 'Turn on phone access' });
    toggle.onclick = async () => {
      try { const next = await api.setPhone(!info.on); renderPhone(next); $('#readerMeta').textContent = next.on ? `on · port ${next.port}` : 'off'; } catch (e) { toast(e.message); }
    };
    const rows = [
      el('p', { className: 'note', textContent: 'Watch your sessions and answer "needs you" prompts from your phone, on the same Wi-Fi. Off by default. The link contains a secret key: anyone with it can type into your sessions, so only open it on your own phone.' }),
      el('div', { className: 'git-actions' }, toggle),
    ];
    if (info.on) {
      for (const url of info.urls) {
        const copy = el('button', { className: 'ghost small', textContent: 'Copy' });
        copy.onclick = () => { api.clipboardWrite(url); toast('Copied. Paste it into your phone (e.g. via a note or chat to yourself).'); };
        rows.push(el('div', { className: 'grow-row' }, el('span', { className: 'gp mono', textContent: url }), copy));
      }
      if (!info.urls.length) rows.push(el('p', { className: 'note', textContent: 'No Wi-Fi/LAN address found.' }));
      const s = S.sessions.get(S.active);
      const share = el('button', { className: 'ghost small', textContent: s ? `Make a read-only link for "${s.info.name}"` : 'Pick a tab to share it' , disabled: !s });
      share.onclick = async () => {
        try {
          const urls = await api.share(s.info.id);
          api.clipboardWrite(urls[0] || '');
          toast('Read-only link copied. It works while phone access is on.');
          rows.push(el('div', { className: 'grow-row' }, el('span', { className: 'gp mono', textContent: urls[0] })));
          $('#phoneBody').replaceChildren(...rows);
        } catch (e) { toast(e.message); }
      };
      const revoke = el('button', { className: 'ghost small danger', textContent: 'Revoke all share links' });
      revoke.onclick = async () => { await api.revokeShares(); toast('Share links revoked'); };
      rows.push(el('div', { className: 'ggroup-title', textContent: 'SHARE ONE SESSION (WATCH ONLY)' }), el('div', { className: 'git-actions' }, share, revoke));
    }
    $('#phoneBody').replaceChildren(...rows);
  }

  // ------------------------------------------------------------ live preview

  let previewUrl = '';
  let reloadTimer;
  async function openPreview() {
    const ports = await api.ports().catch(() => []);
    const items = [
      ...ports.map((p) => ({ label: `http://localhost:${p.port}`, hint: `${p.name} · from ${p.session}`, run: () => showPreview(`http://localhost:${p.port}/`) })),
      { label: 'Serve this folder as a static site', hint: 'for plain HTML/CSS/JS projects', run: async () => showPreview(await api.previewStatic()) },
    ];
    if (items.length === 1) return items[0].run();
    ctx.F.openPicker({ placeholder: 'Preview which site?', items });
  }
  function showPreview(url) {
    previewUrl = url;
    ctx.openPanel('preview', 'Preview', url);
    $('#previewFrame').src = url;
  }
  $('#previewReload').onclick = () => { if (previewUrl) $('#previewFrame').src = previewUrl; };
  $('#previewOpen').onclick = () => previewUrl && api.openExternal(previewUrl);
  function filesChanged(touched) {
    if ($('#previewView').hidden || !previewUrl) return;
    if (!touched.some((f) => !/(^|\/)(node_modules|\.meta|\.git)\//.test(f))) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { $('#previewFrame').src = previewUrl; }, 600); // reload after Claude's edits settle
  }

  // ------------------------------------------------------------ watch mode

  let lastResult = null;
  async function toggleWatch() {
    const w = await api.watch();
    if (w.on) { await api.setWatch({ on: false }); renderTests(null); return toast('Watch mode off'); }
    const cmd = await ctx.C.ask({ title: 'Watch mode: run this command after every change', value: w.command, okLabel: 'Start' });
    if (!cmd?.trim()) return;
    try { const r = await api.setWatch({ on: true, command: cmd }); toast(`Watching: ${r.command}`); } catch (e) { toast(e.message); }
  }
  function renderTests(r, running = false) {
    const b = $('#sbTests');
    if (!r && !running) { b.hidden = true; return; }
    b.hidden = false;
    b.className = 'ci ' + (running ? 'running' : r.ok ? 'ok' : 'fail');
    b.textContent = running ? 'Tests running…' : r.ok ? `Tests ✓ ${(r.ms / 1000).toFixed(1)}s` : `Tests ✗ exit ${r.code}`;
  }
  api.onWatchStatus(({ root }) => { if (root === S.project) renderTests(lastResult, true); });
  api.onWatchResult((r) => {
    if (r.root !== S.project) return;
    const wasOk = lastResult?.ok;
    lastResult = r;
    renderTests(r);
    if (!r.ok && wasOk !== false) toast('Tests failed. Click "Tests ✗" in the status bar to see why.');
  });
  $('#sbTests').onclick = () => {
    if (!lastResult) return;
    const fix = el('button', { className: 'primary', textContent: 'Fix with Claude' });
    fix.onclick = () => ctx.newSession('claude', { name: 'fix tests', prompt: `My tests fail. Command: ${lastResult.command}\n\nEnd of the output:\n\n${lastResult.output.slice(-5000)}\n\nFind the cause and fix it.` });
    showDoc('Test run', `${lastResult.command} · exit ${lastResult.code}`, '```\n' + lastResult.output.slice(-8000).replace(/```/g, "'''") + '\n```', lastResult.ok ? [] : [fix]);
  };

  // ------------------------------------------------------------ voice typing

  async function voice() {
    const s = S.sessions.get(S.active);
    if (!s) return toast('Pick a tab first');
    s.term.focus();
    await api.voice(); // Windows voice typing (Win+H) types into the focused terminal
    toast('Speak now. Windows voice typing writes into the terminal; press Enter to send.');
  }

  // ------------------------------------------------------------ daily recap + learning mode

  async function recap() {
    await busy('Building today’s recap');
    const md = await api.recap();
    const sum = el('button', { className: 'ghost small', textContent: 'Summarize with Claude (Haiku)' });
    sum.onclick = async () => {
      sum.disabled = true;
      sum.textContent = 'Summarizing…';
      try { const s = await api.summarizeRecap(md); await showDoc('Today', 'recap + summary', `${s}\n\n---\n\n${md}`); } catch (e) { toast(e.message); sum.disabled = false; sum.textContent = 'Summarize with Claude (Haiku)'; }
    };
    await showDoc('Today', 'from your Claude transcripts', md, [sum]);
  }

  async function explain() {
    const s = S.sessions.get(S.active);
    if (!s || s.info.kind !== 'claude') return toast('Pick a Claude tab first');
    await busy(`Explaining what happened in "${s.info.name}"`);
    try {
      const md = await api.explain(s.info.claudeId);
      await showDoc('What happened, and why', s.info.name, md);
    } catch (e) { toast(e.message); ctx.showReader(false); }
  }

  // ------------------------------------------------------------ task board

  let cards = [];
  const COLS = [['ideas', 'Ideas'], ['doing', 'Doing'], ['done', 'Done']];
  async function openBoard() {
    cards = await api.board();
    ctx.openPanel('board', 'Task board', S.project ? ctx.base(S.project) : '');
    renderBoard();
  }
  async function saveBoard() { cards = await api.setBoard(cards); renderBoard(); }
  function renderBoard() {
    if ($('#boardView').hidden) return;
    const col = ([key, label]) => {
      const list = cards.filter((c) => c.col === key).sort((a, b) => b.at - a.at);
      const box = el('div', { className: 'bcol' }, el('div', { className: 'ggroup-title', textContent: `${label.toUpperCase()} (${list.length})` }));
      box.ondragover = (e) => { e.preventDefault(); box.classList.add('over'); };
      box.ondragleave = () => box.classList.remove('over');
      box.ondrop = (e) => {
        e.preventDefault();
        box.classList.remove('over');
        const c = cards.find((x) => x.id === e.dataTransfer.getData('text/card'));
        if (c && c.col !== key) { c.col = key; c.at = Date.now(); saveBoard(); }
      };
      for (const c of list) {
        const s = c.sessionId && S.sessions.get(c.sessionId);
        const card = el('div', { className: 'bcard', draggable: true },
          el('div', { className: 'btext', textContent: c.text }),
          s ? el('div', { className: 'bmeta' }, el('span', { className: 'dot ' + (s.info.status || 'paused') }), ` ${s.info.name}`) : null);
        card.ondragstart = (e) => e.dataTransfer.setData('text/card', c.id);
        const actions = el('div', { className: 'bactions' });
        if (key === 'ideas') {
          const go = el('button', { className: 'ghost small', textContent: 'Start Claude' });
          go.onclick = async () => {
            await ctx.newSession('claude', { name: c.text.slice(0, 24), prompt: c.text });
            c.sessionId = S.active;
            c.col = 'doing';
            c.at = Date.now();
            saveBoard();
          };
          actions.append(go);
        }
        if (s) { const open = el('button', { className: 'ghost small', textContent: 'Open tab' }); open.onclick = () => ctx.activate(s.info.id); actions.append(open); }
        const del = el('button', { className: 'gbtn', textContent: 'Delete' });
        del.onclick = () => { cards = cards.filter((x) => x !== c); saveBoard(); };
        actions.append(del);
        card.append(actions);
        box.append(card);
      }
      return box;
    };
    $('#boardCols').replaceChildren(...COLS.map(col));
  }
  $('#boardAdd').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#boardText').value.trim();
    if (!text) return;
    cards.push({ text, col: 'ideas', at: Date.now() });
    $('#boardText').value = '';
    await saveBoard();
  };
  $('#boardText').onkeydown = (e) => e.stopPropagation();

  // ------------------------------------------------------------ hooks

  return {
    filesChanged,
    projectEntered() { lastResult = null; renderTests(null); api.watch().then((w) => { if (w.on) renderTests(null, true); }); },
    statusChanged() { if (!$('#boardView').hidden) renderBoard(); },
    voice,
    commands: () => [
      { label: 'Phone access (watch and answer from your phone)…', run: openPhone },
      { label: 'Share this tab as a read-only link…', run: openPhone },
      { label: 'Live preview of this web project…', run: openPreview },
      { label: 'Watch mode: run tests on every change (toggle)', run: toggleWatch },
      { label: 'Voice typing into the terminal', key: 'Ctrl Shift Space', run: voice },
      { label: "Today's recap", run: recap },
      { label: 'Explain what Claude did in this tab (learning mode)', run: explain },
      { label: 'Task board', run: openBoard },
    ],
  };
}
