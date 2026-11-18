// Dev tooling in the window: permission rules, dependency alerts, secret guard prompt,
// CI status, offline docs, pinned files, templates, and user hooks.

export function init(ctx) {
  const { S, api, $, el, toast } = ctx;
  let pins = [];

  // ------------------------------------------------------------ permission rules

  const SUGGEST = ['Bash(npm test:*)', 'Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(git status)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Read', 'Edit', 'WebFetch'];
  let perms = { allow: [], deny: [] };

  async function openPerms() {
    perms = await api.perms();
    ctx.openPanel('perms', 'Permissions', perms.file || '.claude/settings.local.json');
    renderPerms();
  }
  function renderPerms() {
    const list = (kind) => el('div', { className: 'perm-list' }, ...perms[kind].map((rule) => {
      const rm = el('button', { className: 'gbtn', textContent: 'Remove' });
      rm.onclick = async () => { perms[kind] = perms[kind].filter((r) => r !== rule); await save(); };
      return el('div', { className: 'grow-row' }, el('span', { className: 'gp mono', textContent: rule }), rm);
    }), perms[kind].length ? null : el('p', { className: 'note', textContent: kind === 'allow' ? 'Nothing pre-approved.' : 'Nothing blocked.' }));
    const input = el('input', { className: 'perm-input', placeholder: 'e.g. Bash(npm test:*)' });
    const addAllow = el('button', { className: 'ghost small', textContent: 'Always allow' });
    const addDeny = el('button', { className: 'ghost small danger', textContent: 'Always deny' });
    const add = async (kind) => { const v = input.value.trim(); if (!v) return; perms[kind] = [...perms[kind], v]; await save(); };
    addAllow.onclick = () => add('allow');
    addDeny.onclick = () => add('deny');
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') add('allow'); };
    $('#permsBody').replaceChildren(
      el('p', { className: 'note', textContent: 'Claude Code reads these rules for this project. "Always allow" skips the question; "Always deny" refuses without asking. Saved in .claude/settings.local.json (personal, not shared).' }),
      el('div', { className: 'git-actions' }, input, addAllow, addDeny),
      el('div', { className: 'chips-wrap', style: 'padding:0' }, ...SUGGEST.filter((x) => !perms.allow.includes(x)).map((x) => {
        const b = el('button', { className: 'chipbtn', textContent: '+ ' + x });
        b.onclick = () => { input.value = x; input.focus(); };
        return b;
      })),
      el('div', { className: 'ggroup-title', textContent: `ALWAYS ALLOW (${perms.allow.length})` }), list('allow'),
      el('div', { className: 'ggroup-title', textContent: `ALWAYS DENY (${perms.deny.length})` }), list('deny'),
      el('p', { className: 'note', textContent: 'Tabs that are already open pick up changes when they restart.' }));
  }
  async function save() {
    try { await api.setPerms(perms); perms = await api.perms(); renderPerms(); toast('Rules saved'); } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------ dependency alerts

  api.onDepsAdded(({ file, added }) => {
    toast(`New dependency in ${file}: ${added.join(', ')}`);
    const bar = $('#depsBar');
    bar.querySelector('span').textContent = `New in ${file}: ${added.join(', ')}`;
    bar.hidden = false;
  });
  $('#depsClose').onclick = () => ($('#depsBar').hidden = true);

  // ------------------------------------------------------------ secret guard (called from the commit button)

  async function commit(message) {
    try { return await api.gitCommit(message); } catch (e) {
      const m = /SECRETS:(\[.*\])/.exec(e.message);
      if (!m) throw e;
      const found = JSON.parse(m[1]);
      const lines = found.map((f) => `• ${f.kind} in ${f.file}${f.line ? `: ${f.line}` : ''}`).join('\n');
      if (!confirm(`This commit looks like it contains secrets:\n\n${lines}\n\nCommit anyway?`)) throw new Error('Commit cancelled: remove the secrets or unstage those files');
      return api.gitCommit(message, true);
    }
  }

  // ------------------------------------------------------------ CI status

  function renderCi(run) {
    const sb = $('#sbCi');
    if (!run || run.project !== S.project) { sb.hidden = true; return; }
    const state = run.status !== 'completed' ? 'running' : run.conclusion === 'success' ? 'ok' : 'fail';
    sb.hidden = false;
    sb.className = 'ci ' + state;
    sb.textContent = `CI ${state === 'ok' ? '✓' : state === 'fail' ? '✗' : '●'} ${run.name || run.displayTitle} (${run.headBranch})`;
    sb.title = `${run.displayTitle} · ${run.status}${run.conclusion ? ' · ' + run.conclusion : ''}\nClick to open on GitHub`;
    sb.onclick = () => api.openExternal(run.url);
  }
  api.onCi(renderCi);

  // ------------------------------------------------------------ offline docs

  let docs = [];
  async function openDocs() {
    docs = await api.docs();
    ctx.openPanel('docs', 'Docs', `${docs.length} dependencies with local READMEs`);
    $('#docsFilter').value = '';
    renderDocs();
    $('#docsFilter').focus();
  }
  function renderDocs() {
    const q = $('#docsFilter').value.trim().toLowerCase();
    const list = docs.filter((d) => !q || d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q));
    $('#docsList').replaceChildren(...list.map((d) => {
      const b = el('button', { className: 'rchat', disabled: !d.readme },
        el('span', { className: 'rt', textContent: `${d.name} ${d.version}` }),
        el('span', { className: 'rs', textContent: d.description || (d.readme ? '' : 'No README in node_modules') }));
      b.onclick = () => d.readme && ctx.openFile(d.readme);
      return b;
    }));
    if (!docs.length) $('#docsList').append(el('p', { className: 'note', textContent: 'No installed npm dependencies here. Run npm install first: docs come from node_modules, so they work offline.' }));
  }
  $('#docsFilter').oninput = renderDocs;
  $('#docsFilter').onkeydown = (e) => e.stopPropagation();

  // ------------------------------------------------------------ pinned files

  async function refreshPins() { pins = S.project ? await api.pins() : []; }
  async function togglePin(rel) {
    try {
      pins = await api.togglePin(rel);
      toast(pins.includes(rel) ? `Pinned ${rel}: new Claude tabs start with it` : `Unpinned ${rel}`);
      ctx.renderTree();
    } catch (e) { toast(e.message); }
  }
  function pickPins() {
    if (!pins.length) return toast('Nothing pinned. Right-click a file and choose "Pin for new sessions".');
    ctx.F.openPicker({ placeholder: 'Pinned files (Enter unpins)', items: pins.map((p) => ({ label: p, hint: 'unpin', run: () => togglePin(p) })) });
  }

  // ------------------------------------------------------------ templates

  async function newFromTemplate() {
    const list = await api.templates();
    ctx.F.openPicker({
      placeholder: 'New project from a template',
      items: list.map((t) => ({
        label: t.label,
        run: async () => {
          const name = await ctx.C.ask({ title: `Name for the new ${t.label} project`, value: 'my-project', okLabel: 'Choose folder…' });
          if (!name?.trim()) return;
          try {
            const r = await api.createFromTemplate({ template: t.id, name });
            if (!r) return;
            await ctx.enterProject(r.dir, true);
            if (r.prompt) await ctx.newSession('claude', { name: 'setup', prompt: r.prompt });
            toast(`Created ${r.dir}`);
          } catch (e) { toast(e.message); }
        },
      })),
    });
  }

  // ------------------------------------------------------------ user hooks

  async function openHooks() {
    const h = await api.userHooks();
    ctx.openPanel('hooks', 'Hooks', 'your commands, run on session events');
    for (const k of ['start', 'done', 'needs']) $(`#hook-${k}`).value = h[k] || '';
  }
  $('#hooksSave').onclick = async () => {
    await api.setUserHooks({ start: $('#hook-start').value, done: $('#hook-done').value, needs: $('#hook-needs').value });
    toast('Hooks saved');
  };
  for (const k of ['start', 'done', 'needs']) $(`#hook-${k}`).onkeydown = (e) => e.stopPropagation();

  // ------------------------------------------------------------ hooks for app.js

  return {
    commit,
    openPerms,
    openDocs,
    openHooks,
    togglePin,
    isPinned: (p) => pins.includes(p),
    async projectEntered() {
      $('#depsBar').hidden = true;
      await refreshPins();
      renderCi(await api.ci());
    },
    commands: () => [
      { label: 'Permission rules (always allow / deny)…', run: openPerms },
      { label: 'Dependency docs (offline READMEs)…', run: openDocs },
      { label: 'Pinned files…', run: pickPins },
      { label: 'New project from a template…', run: newFromTemplate },
      { label: 'Hooks: run a command when a session starts, finishes or needs you', run: openHooks },
      { label: 'Refresh CI status', run: () => api.ciRefresh() },
    ],
  };
}
