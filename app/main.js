// meta IDE main process: owns the window, every terminal session (node-pty),
// the project file list + watcher, Markdown rendering, Claude status hooks
// and the token tracker. The window only renders what this sends it.
'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, clipboard, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const pty = require('@lydell/node-pty');
const MarkdownIt = require('markdown-it');

const APP_DIR = __dirname;
let win = null;

// ---------------------------------------------------------------- state

const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
let state = { recent: [], project: null, sessions: [], active: {} };

function loadState() {
  let raw = null;
  try { raw = fs.readFileSync(STATE_FILE(), 'utf8'); } catch { /* first run */ }
  if (raw != null) {
    try {
      state = { ...state, ...JSON.parse(raw.replace(/^﻿/, '')) }; // tolerate a BOM from editors/PowerShell
    } catch {
      // Never silently replace a file we couldn't read: keep a copy for recovery.
      fs.copyFileSync(STATE_FILE(), STATE_FILE().replace(/\.json$/, `.unreadable-${Date.now()}.json`));
    }
  }
  state.recent = state.recent.filter((p) => fs.existsSync(p));
  for (const q of state.queue ?? []) if (q.status === 'running') { q.status = 'failed'; q.summary = 'interrupted: the app was closed'; }
  if (state.project && !fs.existsSync(state.project)) state.project = null;
}
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    // Atomic save: write a temp file, then rename over the old one, so a crash mid-write
    // can't leave a half-written state file.
    const tmp = STATE_FILE() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE());
  }, 200);
}
/** Where a session's process runs: its own git worktree when isolated, else the project. */
const workDir = (s) => s.cwd || s.project;
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const publicSession = (s) => {
  const l = live.get(s.id);
  return { id: s.id, project: s.project, name: s.name, kind: s.kind, claudeId: s.claudeId, model: s.model || '', createdAt: s.createdAt,
    isolated: s.isolated ? { branch: s.isolated.branch } : null, asleep: !l && !!s.asleep,
    running: !!l, status: l ? l.status : 'paused' };
};

// ---------------------------------------------------------------- Claude hooks
// Each Claude session gets `--settings hooks.json`. The hooks call hook.js, which
// POSTs here. Event-driven status instead of guessing from terminal output.

const hookSecret = crypto.randomBytes(16).toString('hex');
let hookUrl = '';
const HOOKS_FILE = () => path.join(app.getPath('userData'), 'hooks.json');

function writeHooksFile() {
  const cmd = (ev) => [{ type: 'command', command: `node "${path.join(APP_DIR, 'hook.js')}" ${ev}`, timeout: 5 }];
  const settings = {
    hooks: {
      UserPromptSubmit: [{ hooks: cmd('working') }],
      PreToolUse: [{ matcher: '*', hooks: cmd('pre') }],
      PostToolUse: [{ matcher: '*', hooks: cmd('post') }],
      Notification: [{ hooks: cmd('notify') }],
      Stop: [{ hooks: cmd('done') }],
    },
  };
  fs.mkdirSync(path.dirname(HOOKS_FILE()), { recursive: true });
  fs.writeFileSync(HOOKS_FILE(), JSON.stringify(settings, null, 2));
}

function startHookServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'POST' || u.pathname !== '/hook' || u.searchParams.get('k') !== hookSecret) {
        res.writeHead(403); return res.end();
      }
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 100000) req.destroy(); });
      req.on('end', () => {
        // Handle first, reply after: PreToolUse blocks Claude until we answer, so a
        // file snapshot taken here is guaranteed to be from before the edit.
        try { onHook(JSON.parse(body)); } catch { /* ignore bad payloads */ }
        res.writeHead(204); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      hookUrl = `http://127.0.0.1:${server.address().port}/hook?k=${hookSecret}`;
      resolve();
    });
  });
}

function onHook({ tab, event, message, tool, file }) {
  const l = live.get(tab);
  if (!l) return;
  if (event === 'pre' || event === 'post') {
    setStatus(tab, 'working');
    if (FILE_TOOLS.has(tool) && file) trackChange(tab, file, event, tool);
  } else if (event === 'working') setStatus(tab, 'working');
  else if (event === 'done') setStatus(tab, 'done');
  else if (event === 'notify') {
    // "needs your permission" -> needs you. "waiting for your input" after a finished turn stays done.
    const m = String(message || '');
    if (/permission|approve|allow/i.test(m) || l.status === 'working') setStatus(tab, 'needs', m);
  }
}

function setStatus(id, status, message = '') {
  const l = live.get(id);
  if (!l || l.status === status) return;
  l.status = status;
  send('session:status', { id, status });
  const s = state.sessions.find((x) => x.id === id);
  const watching = win && win.isFocused() && state.active[s?.project] === id;
  if (s && !watching && (status === 'needs' || status === 'done') && Notification.isSupported()) {
    const n = new Notification({
      title: status === 'needs' ? `${s.name} needs you` : `${s.name} is done`,
      body: message || path.basename(s.project),
      silent: status === 'done',
    });
    n.on('click', () => { if (!win) return; win.show(); win.focus(); send('session:focus', id); });
    n.show();
  }
}

// ---------------------------------------------------------------- per-session changes
// Before Claude's first edit to a file in a session, keep a copy of the file. The diff
// is that copy vs. the file now. Covers Write/Edit/MultiEdit/NotebookEdit; files changed
// by shell commands aren't attributed (no file path in the hook).

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_SNAPSHOT = 2 * 1024 * 1024;
const changes = new Map(); // tab id -> Map(rel -> { before: string|null, at })
const timelines = new Map(); // tab id -> [{ id, at, file, tool, before, after }] one entry per edit
const pendingBefore = new Map(); // `${tab}\0${file}` -> content just before the current edit
const MAX_EVENTS = 300;
const CHANGES_DIR = () => path.join(app.getPath('userData'), 'changes');

function loadChangeFile(tab) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(CHANGES_DIR(), `${tab}.json`), 'utf8')); } catch { /* none yet */ }
  // v1 files were a plain { path: change } object; v2 is { files, events }.
  const isV2 = raw && raw.files && Array.isArray(raw.events);
  changes.set(tab, new Map(Object.entries(isV2 ? raw.files : raw)));
  timelines.set(tab, isV2 ? raw.events : []);
}
function changesFor(tab) {
  if (!changes.has(tab)) loadChangeFile(tab);
  return changes.get(tab);
}
function timelineFor(tab) {
  if (!timelines.has(tab)) loadChangeFile(tab);
  return timelines.get(tab);
}
const persistTimers = new Map();
function persistChanges(tab) {
  clearTimeout(persistTimers.get(tab));
  persistTimers.set(tab, setTimeout(() => {
    fs.mkdirSync(CHANGES_DIR(), { recursive: true });
    fs.writeFileSync(path.join(CHANGES_DIR(), `${tab}.json`), JSON.stringify({ files: Object.fromEntries(changesFor(tab)), events: timelineFor(tab) }));
  }, 500));
}

function readSnapshot(abs) {
  try { return fs.statSync(abs).size <= MAX_SNAPSHOT ? fs.readFileSync(abs, 'utf8') : undefined; } catch { return null; }
}

function trackChange(tab, file, event, tool) {
  const s = state.sessions.find((x) => x.id === tab);
  if (!s) return;
  const abs = path.resolve(workDir(s), file);
  const rel = path.relative(workDir(s), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return; // outside the project
  const key = rel.split(path.sep).join('/');
  const m = changesFor(tab);
  const pk = `${tab}\0${key}`;
  if (event === 'pre') {
    const before = readSnapshot(abs);
    if (before === undefined) return; // too large to keep
    if (!m.has(key)) m.set(key, { before, at: Date.now() }); // session baseline: first edit only
    pendingBefore.set(pk, before); // this edit's own "before", for the timeline
    persistChanges(tab);
  } else if (event === 'post' && pendingBefore.has(pk)) {
    const before = pendingBefore.get(pk);
    pendingBefore.delete(pk);
    const after = readSnapshot(abs);
    if (after !== undefined && after !== before) {
      const tl = timelineFor(tab);
      tl.push({ id: crypto.randomUUID(), at: Date.now(), file: key, tool, before, after });
      if (tl.length > MAX_EVENTS) tl.splice(0, tl.length - MAX_EVENTS);
      persistChanges(tab);
    }
  }
  if (m.has(key)) { m.get(key).at = Date.now(); send('changes:update', { id: tab }); }
}

ipcMain.handle('timeline:list', (_e, tab) =>
  timelineFor(tab).map(({ id, at, file, tool, before, after }) => ({ id, at, file, tool, created: before === null, deleted: after === null })));

ipcMain.handle('timeline:diff', (_e, tab, eventId) => {
  const ev = timelineFor(tab).find((x) => x.id === eventId);
  if (!ev) throw new Error('that edit is no longer in the timeline');
  return { file: ev.file, before: ev.before ?? '', after: ev.after ?? '' };
});

/** Put every file back to how it was right after `eventId`, undoing all later edits. */
ipcMain.handle('timeline:undoTo', (_e, tab, eventId) => {
  const s = state.sessions.find((x) => x.id === tab);
  const tl = timelineFor(tab);
  const i = eventId === 'start' ? -1 : tl.findIndex((x) => x.id === eventId);
  if (!s || (i < 0 && eventId !== 'start')) throw new Error('that edit is no longer in the timeline');
  const later = tl.slice(i + 1);
  const restore = new Map(); // file -> content from before its earliest later edit
  for (const ev of later) if (!restore.has(ev.file)) restore.set(ev.file, ev.before);
  for (const [file, content] of restore) {
    const abs = inProjectOf(workDir(s), file);
    if (content === null) fs.rmSync(abs, { force: true });
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
  }
  tl.splice(i + 1);
  persistChanges(tab);
  send('changes:update', { id: tab });
  return { files: restore.size, edits: later.length };
});

function readNow(project, rel) {
  try { return fs.readFileSync(path.join(project, rel), 'utf8'); } catch { return null; }
}

ipcMain.handle('changes:list', (_e, tab) => {
  const s = state.sessions.find((x) => x.id === tab);
  if (!s) return [];
  return [...changesFor(tab)].map(([p, c]) => {
    const now = readNow(workDir(s), p);
    const kind = c.before === null ? (now === null ? 'gone' : 'new') : now === null ? 'deleted' : now === c.before ? 'same' : 'edited';
    return { path: p, kind, at: c.at };
  }).filter((c) => c.kind !== 'same' && c.kind !== 'gone').sort((a, b) => b.at - a.at);
});

ipcMain.handle('changes:diff', (_e, tab, rel) => {
  const s = state.sessions.find((x) => x.id === tab);
  const c = s && changesFor(tab).get(rel);
  if (!c) throw new Error('no change recorded for that file');
  return { before: c.before ?? '', after: readNow(workDir(s), rel) ?? '' };
});

ipcMain.handle('changes:revert', (_e, tab, rel) => {
  const s = state.sessions.find((x) => x.id === tab);
  const c = s && changesFor(tab).get(rel);
  if (!c) throw new Error('no change recorded for that file');
  const abs = inProjectOf(workDir(s), rel);
  if (c.before === null) fs.rmSync(abs, { force: true });
  else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c.before); }
  changesFor(tab).delete(rel);
  // Those edits are undone, so they leave the timeline too.
  const tl = timelineFor(tab);
  for (let i = tl.length - 1; i >= 0; i--) if (tl[i].file === rel) tl.splice(i, 1);
  persistChanges(tab);
  return true;
});

function inProjectOf(project, rel) {
  const abs = path.resolve(project, rel);
  const r = path.relative(project, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error('path outside the project');
  return abs;
}

// ---------------------------------------------------------------- handoff
// "Continue in a new tab": a fresh Claude session (small context) that starts with the
// tail of the old conversation, read locally from Claude's transcript.

function transcriptFile(claudeId) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(base)) {
      const f = path.join(base, d, `${claudeId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* no projects dir */ }
  return null;
}

function conversationTail(claudeId, maxChars = 6000) {
  const f = transcriptFile(claudeId);
  if (!f) return '';
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const turns = [];
  for (const line of lines) {
    if (!line.includes('"message"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const c = o.message?.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '';
    if (!text.trim() || text.startsWith('<')) continue; // skip tool results and system notes
    turns.push(`${o.type === 'user' ? 'Me' : 'Claude'}: ${text.trim().slice(0, 700)}`);
  }
  let out = '';
  for (let i = turns.length - 1; i >= 0; i--) {
    if (out.length + turns[i].length > maxChars) break;
    out = turns[i] + '\n\n' + out;
  }
  return out.trim();
}

ipcMain.handle('session:handoff', (_e, id, cols = 120, rows = 32) => {
  const old = state.sessions.find((x) => x.id === id);
  if (!old || old.kind !== 'claude') throw new Error('pick a Claude session');
  const tail = conversationTail(old.claudeId);
  if (!tail) throw new Error('that session has no conversation to continue yet');
  const prompt = `This continues an earlier session ("${old.name}"). The end of that conversation:\n\n${tail}\n\n` +
    'Pick up where it left off. First, in two or three lines, say what you think the current state is, then wait for me.';
  const s = { id: crypto.randomUUID(), project: old.project, kind: 'claude', name: `${old.name} (cont.)`.slice(0, 40), claudeId: crypto.randomUUID(), model: old.model || '', createdAt: Date.now() };
  state.sessions.push(s);
  state.active[s.project] = s.id;
  saveState();
  spawnSession(s, cols, rows, prompt);
  return publicSession(s);
});

// ---------------------------------------------------------------- night queue
// Tasks run one after another, unattended, each through `meta run` in its own git
// worktree, so nothing touches your files until you Apply in the morning.

const META_BIN = path.join(APP_DIR, '..', 'bin', 'meta.js');
let queueProc = null;
let queueStopping = false;

const queueItems = () => (state.queue ??= []);
const sendQueue = () => send('queue:update', queueItems());

function runMeta(args, cwd) {
  return execFileSync('node', [META_BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  return env;
}

function nextQueued() {
  if (queueProc || queueStopping) return;
  const item = queueItems().find((q) => q.status === 'pending');
  if (!item) { sendQueue(); return; }
  item.status = 'running';
  item.startedAt = Date.now();
  item.log = [];
  saveState();
  sendQueue();
  const agent = item.model ? `claude:${item.model}` : 'claude';
  const args = [META_BIN, 'run', item.task, '-a', agent, '--json', ...(item.yolo ? ['--yolo'] : [])];
  queueProc = spawn('node', args, { cwd: item.project, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  queueProc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind === 'meta') { item.runId = ev.run; item.base = ev.base; }
      else if (ev.kind === 'tool') item.log.push(`→ ${ev.name} ${String(ev.detail || '').slice(0, 80)}`);
      else if (ev.kind === 'done') item.summary = String(ev.summary || '').slice(0, 2000);
      if (item.log.length > 40) item.log = item.log.slice(-40);
      sendQueue();
    }
  });
  queueProc.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  queueProc.on('close', (code) => {
    queueProc = null;
    item.endedAt = Date.now();
    item.status = queueStopping ? 'cancelled' : code === 0 ? 'done' : 'failed';
    if (item.status === 'failed' && !item.summary) item.summary = err.trim().split('\n').slice(-3).join('\n') || `exit ${code}`;
    try {
      if (item.runId && item.base) {
        item.files = execFileSync('git', ['diff', '--name-only', item.base, `meta/${item.runId}`], { cwd: item.project, encoding: 'utf8' }).split('\n').filter(Boolean);
      }
    } catch { item.files = []; }
    saveState();
    const s = item;
    if (Notification.isSupported()) new Notification({ title: `Queue: ${s.status}`, body: s.task.slice(0, 100), silent: true }).show();
    queueStopping = false;
    nextQueued();
  });
}

ipcMain.handle('queue:list', () => queueItems());
ipcMain.handle('queue:add', (_e, { task, model = '', yolo = false }) => {
  if (!state.project) throw new Error('open a folder first');
  if (!String(task || '').trim()) throw new Error('write a task first');
  try { execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.project, stdio: 'ignore' }); }
  catch { throw new Error('the queue needs a git repository with at least one commit'); }
  queueItems().push({ id: crypto.randomUUID(), project: state.project, task: String(task).trim(), model, yolo: !!yolo, status: 'pending', createdAt: Date.now() });
  saveState();
  sendQueue();
  return queueItems();
});
ipcMain.handle('queue:remove', (_e, id) => {
  const q = queueItems().find((x) => x.id === id);
  if (q?.status === 'running') throw new Error('stop the queue first');
  state.queue = queueItems().filter((x) => x.id !== id);
  saveState();
  sendQueue();
  return state.queue;
});
ipcMain.handle('queue:start', () => { queueStopping = false; nextQueued(); return true; });
ipcMain.handle('queue:stop', () => {
  if (queueProc) { queueStopping = true; queueProc.kill(); }
  return true;
});
ipcMain.handle('queue:diff', (_e, id) => {
  const q = queueItems().find((x) => x.id === id);
  if (!q?.runId || !q.base) throw new Error('no result to show');
  const show = (rev, f) => { try { return execFileSync('git', ['show', `${rev}:${f}`], { cwd: q.project, encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
  return (q.files || []).map((f) => ({ path: f, before: show(q.base, f), after: show(`meta/${q.runId}`, f) }));
});
ipcMain.handle('queue:apply', (_e, id) => {
  const q = queueItems().find((x) => x.id === id);
  if (!q?.runId) throw new Error('no result to apply');
  runMeta(['apply', q.runId], q.project);
  q.status = 'applied';
  saveState();
  sendQueue();
  return true;
});
ipcMain.handle('queue:discard', (_e, id) => {
  const q = queueItems().find((x) => x.id === id);
  if (q?.runId) { try { runMeta(['discard', q.runId], q.project); } catch { /* already gone */ } }
  if (q) q.status = 'discarded';
  saveState();
  sendQueue();
  return true;
});

// ---------------------------------------------------------------- search
// Text search in project files (git grep when it's a repo, else a plain scan) and in
// past Claude conversations for this project (Claude's local transcripts).

ipcMain.handle('search:files', (_e, query) => {
  const q = String(query || '');
  if (!state.project || q.trim().length < 2) return [];
  const results = [];
  try {
    const out = execFileSync('git', ['grep', '-n', '-I', '-i', '-F', '--untracked', '-e', q], {
      cwd: state.project, encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split(/\r?\n/)) { // CRLF files: a trailing \r would defeat the regex's "."
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (m && !m[1].split('/').some((p) => IGNORE.has(p))) results.push({ path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) });
      if (results.length >= 300) break;
    }
    return results;
  } catch (err) {
    if (err.status === 1) return []; // git grep: no matches
  }
  const lq = q.toLowerCase();
  for (const f of fileSet) {
    let text;
    try { const st = fs.statSync(path.join(state.project, f)); if (st.size > 1 << 20) continue; text = fs.readFileSync(path.join(state.project, f), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    text.split('\n').forEach((l, i) => { if (results.length < 300 && l.toLowerCase().includes(lq)) results.push({ path: f, line: i + 1, text: l.trim().slice(0, 200) }); });
    if (results.length >= 300) break;
  }
  return results;
});

/** Claude names a project's transcript folder after its path: every non-alphanumeric becomes '-'. */
const transcriptDir = (project) => path.join(os.homedir(), '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));

ipcMain.handle('search:chats', (_e, query) => {
  const lq = String(query || '').toLowerCase().trim();
  if (!state.project || lq.length < 2) return [];
  const dir = transcriptDir(state.project);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const results = [];
  for (const f of files) {
    const claudeId = f.slice(0, -6);
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (!text.toLowerCase().includes(lq)) continue;
    let first = '', at = 0, hits = 0, snippet = '';
    for (const line of text.split('\n')) {
      if (!line.includes('"message"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
      const c = o.message?.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
      if (!t || t.startsWith('<')) continue;
      if (!first && o.type === 'user') first = t.slice(0, 120);
      at = Date.parse(o.timestamp) || at;
      const idx = t.toLowerCase().indexOf(lq);
      if (idx >= 0) {
        hits++;
        if (!snippet) snippet = (idx > 60 ? '…' : '') + t.slice(Math.max(0, idx - 60), idx + 120).replace(/\s+/g, ' ');
      }
    }
    if (!hits) continue;
    const inIde = state.sessions.find((s) => s.claudeId === claudeId);
    results.push({ claudeId, title: inIde?.name || first || claudeId.slice(0, 8), at, hits, snippet, sessionId: inIde?.id ?? null });
  }
  return results.sort((a, b) => b.at - a.at).slice(0, 50);
});

/** Open a past conversation (found by search) as a tab: claude --resume <id>. */
ipcMain.handle('session:resumeChat', (_e, claudeId, title, cols = 120, rows = 32) => {
  if (!state.project || !/^[0-9a-f-]{36}$/i.test(claudeId)) throw new Error('bad conversation id');
  const existing = state.sessions.find((s) => s.claudeId === claudeId);
  if (existing) return publicSession(existing);
  const s = { id: crypto.randomUUID(), project: state.project, kind: 'claude', name: String(title || 'resumed').slice(0, 40), claudeId, model: '', createdAt: Date.now() };
  state.sessions.push(s);
  state.active[s.project] = s.id;
  saveState();
  spawnSession(s, cols, rows);
  return publicSession(s);
});

// ---------------------------------------------------------------- prompt snippets

const DEFAULT_SNIPPETS = [
  { id: 'review', name: 'Review my changes', text: 'Review the uncommitted changes in this repo. List real bugs first, then risky spots. Be brief.' },
  { id: 'tests', name: 'Write tests', text: 'Write tests for the code I just changed. Match the existing test style and run them.' },
  { id: 'explain', name: 'Explain this file', text: 'Explain what this file does, how it fits in the project, and anything surprising: ' },
  { id: 'plan', name: 'Plan first', text: 'Before changing anything, write a short plan in PLAN.md and wait for my OK.' },
  { id: 'commit', name: 'Commit', text: 'Commit the current changes with a clear message. Show me the message first.' },
];
ipcMain.handle('snippets:get', () => (state.snippets ??= DEFAULT_SNIPPETS));
ipcMain.handle('snippets:set', (_e, list) => {
  if (!Array.isArray(list)) throw new Error('bad snippets');
  state.snippets = list.filter((s) => s && typeof s.name === 'string' && typeof s.text === 'string')
    .slice(0, 100).map((s) => ({ id: String(s.id || crypto.randomUUID()), name: s.name.slice(0, 60), text: s.text.slice(0, 8000) }));
  saveState();
  return state.snippets;
});

// ---------------------------------------------------------------- git (commit panel)

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: state.project, encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}
const gitErr = (e) => new Error(String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-4).join('\n'));

ipcMain.handle('git:status', () => {
  if (!state.project) return { repo: false };
  try { git(['rev-parse', '--is-inside-work-tree']); } catch { return { repo: false }; }
  let branch = '', ahead = null;
  try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { branch = '(no commits yet)'; }
  try { ahead = Number(git(['rev-list', '--count', '@{u}..HEAD']).trim()); } catch { ahead = null; }
  const files = [];
  const parts = git(['status', '--porcelain=v1', '-z', '-uall']).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const x = p[0], y = p[1], file = p.slice(3);
    if (x === 'R' || x === 'C') i++; // rename: next field is the old path
    if (file.split('/').some((seg) => IGNORE.has(seg))) continue;
    files.push({ path: file, staged: x !== ' ' && x !== '?', unstaged: y !== ' ', untracked: x === '?', code: (x + y).trim() || '?' });
  }
  return { repo: true, branch, ahead, files };
});

ipcMain.handle('git:diff', (_e, rel, staged) => {
  inProject(rel);
  const show = (rev) => { try { return git(['show', `${rev}:${rel}`]); } catch { return ''; } };
  if (staged) return { before: show('HEAD'), after: show('') };
  return { before: show('') || show('HEAD'), after: readNow(state.project, rel) ?? '' };
});
ipcMain.handle('git:stage', (_e, paths) => { try { git(['add', '--', ...paths.map((p) => (inProject(p), p))]); return true; } catch (e) { throw gitErr(e); } });
ipcMain.handle('git:unstage', (_e, paths) => { try { git(['reset', '-q', 'HEAD', '--', ...paths.map((p) => (inProject(p), p))]); return true; } catch (e) { throw gitErr(e); } });
ipcMain.handle('git:commit', (_e, message) => {
  if (!String(message || '').trim()) throw new Error('write a commit message first');
  try { return git(['commit', '-F', '-'], { input: String(message) }).trim(); } catch (e) { throw gitErr(e); }
});
ipcMain.handle('git:push', () => {
  try { return git(['push'], { env: cleanEnv() }).trim() || 'pushed'; } catch (e) {
    const msg = String(e.stderr || '');
    if (/no upstream/i.test(msg)) {
      try { return git(['push', '-u', 'origin', 'HEAD'], { env: cleanEnv() }).trim() || 'pushed'; } catch (e2) { throw gitErr(e2); }
    }
    throw gitErr(e);
  }
});

/** Ask Claude (headless, cheap model) for a commit message from the staged diff. */
ipcMain.handle('git:suggest', () => new Promise((resolve, reject) => {
  let diff = '';
  try { diff = git(['diff', '--cached', '--stat', '-p', '--no-color']); } catch (e) { return reject(gitErr(e)); }
  if (!diff.trim()) return reject(new Error('stage some files first'));
  claudeExe ??= whichClaude();
  if (!claudeExe) return reject(new Error('Claude Code was not found on PATH'));
  const prompt = 'Write a git commit message for the staged diff on stdin. First line: imperative summary under 72 characters. ' +
    'Then a blank line and up to 4 short bullet points if useful. Output only the message, nothing else.';
  const child = spawn(claudeExe, ['-p', prompt, '--model', 'haiku', '--output-format', 'text'], { cwd: state.project, env: cleanEnv() });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('error', reject);
  child.on('close', (code) => (code === 0 && out.trim() ? resolve(out.trim().replace(/^```\w*\n?|```$/g, '').trim()) : reject(new Error(err.trim() || 'Claude gave no message'))));
  child.stdin.end(diff.slice(0, 60000));
}));

// ---------------------------------------------------------------- terminal sessions

const live = new Map(); // id -> { proc, buffer, status, pending, timer }
const MAX_BUFFER = 400_000; // chars of scrollback kept to replay after a window reload

function whichClaude() {
  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    return out.find((p) => p.toLowerCase().endsWith('.exe')) || out[0];
  } catch { return null; }
}
let claudeExe = null;

/** Claude stores each conversation as ~/.claude/projects/<dir>/<sessionId>.jsonl */
function transcriptExists(claudeId) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  try {
    return fs.readdirSync(base).some((d) => fs.existsSync(path.join(base, d, `${claudeId}.jsonl`)));
  } catch { return false; }
}

function spawnSession(s, cols, rows, prompt) {
  const env = { ...process.env, META_HOOK_URL: hookUrl, META_TAB: s.id, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  // The IDE is the host. If it was itself launched from inside a Claude session, these markers
  // would make Claude think it's a nested child: it then turns off transcript saving,
  // which breaks --resume and the token tracker.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE']) delete env[k];
  let file, args;
  if (s.kind === 'claude') {
    claudeExe ??= whichClaude();
    if (!claudeExe) throw new Error('Claude Code was not found on PATH');
    file = claudeExe;
    args = ['--settings', HOOKS_FILE(), '--name', s.name];
    if (s.model && /^[\w.:-]+$/.test(s.model)) args.push('--model', s.model); // this session only
    args.push(...(transcriptExists(s.claudeId) ? ['--resume', s.claudeId] : ['--session-id', s.claudeId]));
    if (prompt) args.push(prompt);
  } else {
    file = 'powershell.exe';
    args = ['-NoLogo'];
  }
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: workDir(s), env, useConpty: true });
  const l = { proc, buffer: '', status: 'idle', pending: '', timer: null, lastActive: Date.now() };
  live.set(s.id, l);
  proc.onData((d) => {
    l.lastActive = Date.now();
    l.buffer += d;
    if (l.buffer.length > MAX_BUFFER) l.buffer = l.buffer.slice(-MAX_BUFFER);
    l.pending += d;
    // Batch output into ~60 fps frames: far fewer IPC messages than one per chunk.
    l.timer ??= setTimeout(() => { send('pty:data', { id: s.id, data: l.pending }); l.pending = ''; l.timer = null; }, 16);
  });
  proc.onExit(({ exitCode }) => {
    if (l.timer) { clearTimeout(l.timer); send('pty:data', { id: s.id, data: l.pending }); }
    live.delete(s.id);
    send('pty:exit', { id: s.id, exitCode, asleep: !!s.asleep });
    send('session:status', { id: s.id, status: 'paused' });
  });
  send('session:status', { id: s.id, status: 'idle' });
  return l;
}

ipcMain.handle('session:create', (_e, { kind = 'claude', name, prompt, model = '', cols = 120, rows = 32 } = {}) => {
  if (!state.project) throw new Error('open a folder first');
  const count = state.sessions.filter((x) => x.project === state.project && x.kind === kind).length;
  const s = {
    id: crypto.randomUUID(),
    project: state.project,
    kind,
    name: (name || (kind === 'claude' ? `claude ${count + 1}` : `shell ${count + 1}`)).slice(0, 40),
    claudeId: crypto.randomUUID(),
    model: kind === 'claude' && /^[\w.:-]*$/.test(model) ? model : '',
    createdAt: Date.now(),
  };
  state.sessions.push(s);
  state.active[s.project] = s.id;
  saveState();
  spawnSession(s, cols, rows, prompt);
  return publicSession(s);
});

ipcMain.handle('session:attach', (_e, id, cols, rows) => {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) throw new Error('no such session');
  let l = live.get(id);
  if (!l) { s.asleep = false; l = spawnSession(s, cols, rows); } // paused tab: resume it now (idle tabs cost no RAM)
  else try { l.proc.resize(cols, rows); } catch { /* exited */ }
  // The buffer already contains any output still waiting to be flushed: drop it so it isn't shown twice.
  if (l.timer) { clearTimeout(l.timer); l.timer = null; }
  l.pending = '';
  return { buffer: l.buffer, status: l.status };
});

ipcMain.on('session:write', (_e, id, data) => {
  const l = live.get(id);
  if (!l) return;
  l.lastActive = Date.now();
  l.proc.write(data);
});
ipcMain.on('session:resize', (_e, id, cols, rows) => {
  if (cols > 0 && rows > 0) try { live.get(id)?.proc.resize(cols, rows); } catch { /* exited */ }
});
ipcMain.on('session:active', (_e, id) => { if (state.project) { state.active[state.project] = id; saveState(); } });

ipcMain.handle('session:close', (_e, id) => {
  const l = live.get(id);
  if (l) { try { l.proc.kill(); } catch { /* gone */ } live.delete(id); }
  state.sessions = state.sessions.filter((x) => x.id !== id);
  saveState();
  changes.delete(id);
  fs.rmSync(path.join(CHANGES_DIR(), `${id}.json`), { force: true });
  return true;
});

ipcMain.handle('session:rename', (_e, id, name) => {
  const s = state.sessions.find((x) => x.id === id);
  if (s && typeof name === 'string' && name.trim()) { s.name = name.trim().slice(0, 40); saveState(); }
  return s ? publicSession(s) : null;
});

// ---------------------------------------------------------------- projects + files

const IGNORE = new Set(['node_modules', '.git', '.meta', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', '.gradle', '.idea', 'target', 'coverage']);
let fileSet = new Set();
let watcher = null;

function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter((f) => f && !f.split('/').some((p) => IGNORE.has(p)) && fs.existsSync(path.join(root, f))).slice(0, 20000);
  } catch {
    const files = [];
    const walk = (dir, rel) => {
      if (files.length >= 20000) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (IGNORE.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (e.isFile()) files.push(r);
      }
    };
    walk(root, '');
    return files;
  }
}

function watchProject(root) {
  watcher?.close();
  fileSet = new Set(listFiles(root));
  let changed = new Set();
  let timer = null;
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = name.split(path.sep).join('/');
      if (rel.split('/').some((p) => IGNORE.has(p))) return;
      changed.add(rel);
      clearTimeout(timer);
      // Debounce: an agent writing a file fires many events; send one update.
      timer = setTimeout(() => {
        const before = fileSet;
        fileSet = new Set(listFiles(root));
        const touched = [...changed].filter((f) => fileSet.has(f));
        const created = touched.filter((f) => !before.has(f));
        changed = new Set();
        send('fs:changed', { files: [...fileSet], touched, created });
      }, 300);
    });
  } catch { watcher = null; }
}

function setProject(dir) {
  const abs = path.resolve(dir);
  if (!fs.statSync(abs).isDirectory()) throw new Error('not a folder');
  state.project = abs;
  state.recent = [abs, ...state.recent.filter((p) => p !== abs)].slice(0, 12);
  saveState();
  watchProject(abs);
}

/** Resolve a project-relative path, refusing anything outside the project. */
function inProject(rel) {
  if (!state.project || typeof rel !== 'string') throw new Error('no project');
  const abs = path.resolve(state.project, rel);
  const r = path.relative(state.project, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error('path outside the project');
  return abs;
}

ipcMain.handle('state:get', () => ({
  project: state.project,
  recent: state.recent,
  sessions: state.sessions.map(publicSession),
  active: state.active,
  home: os.homedir(),
}));

ipcMain.handle('project:pick', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  setProject(r.filePaths[0]);
  return state.project;
});
ipcMain.handle('project:set', (_e, dir) => { setProject(dir); return state.project; });
ipcMain.handle('fs:list', () => (state.project ? [...fileSet] : []));
ipcMain.handle('fs:reveal', (_e, rel) => shell.showItemInFolder(inProject(rel)));

const md = new MarkdownIt({ html: false, linkify: true }); // html:false: raw HTML in .md is escaped, never run
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
md.renderer.rules.fence = (tokens, i) => {
  const t = tokens[i];
  const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
  if (lang === 'mermaid') return `<div class="mermaid-src" data-src="${esc(t.content)}"></div>`;
  return `<div class="codeblock"><button class="copy" type="button">Copy</button><pre data-lang="${esc(lang)}"><code>${esc(t.content)}</code></pre></div>`;
};

function renderMarkdown(src) {
  return md.render(src)
    .replace(/<li>(<p>)?\[ \] /g, '<li class="task">$1<input type="checkbox" disabled> ')
    .replace(/<li>(<p>)?\[[xX]\] /g, '<li class="task">$1<input type="checkbox" checked disabled> ');
}

ipcMain.handle('fs:read', (_e, rel) => {
  const abs = inProject(rel);
  const st = fs.statSync(abs);
  if (st.size > 3 * 1024 * 1024) return { binary: true, size: st.size };
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size };
  const content = buf.toString('utf8');
  const isMd = /\.(md|markdown|mdx)$/i.test(rel);
  return { content, html: isMd ? renderMarkdown(content) : null, mtime: st.mtimeMs };
});

// ---------------------------------------------------------------- token tracker
// Claude Code logs every reply, with token counts, in ~/.claude/projects/*/*.jsonl.
// Read those incrementally (only new bytes) and summarize. Free, local, no API.

const usage = new Map(); // message id -> { ts, sid, cwd, input, output, cacheWrite, cacheRead }
const offsets = new Map(); // file -> bytes already parsed

function scanTokens() {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const cutoff = Date.now() - 30 * 86400_000;
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const d of dirs) {
    const dir = path.join(base, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const from = offsets.get(file) ?? 0;
      if (st.size <= from) continue;
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) continue; // partial line: wait for the rest
      offsets.set(file, from + Buffer.byteLength(text.slice(0, lastNl + 1)));
      for (const line of text.slice(0, lastNl).split('\n')) {
        if (!line.includes('"usage"')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        const u = o.message?.usage;
        if (o.type !== 'assistant' || !u) continue;
        const key = o.message.id || o.uuid;
        usage.set(key, {
          ts: Date.parse(o.timestamp) || st.mtimeMs,
          sid: o.sessionId,
          cwd: o.cwd || '',
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
        });
      }
    }
  }
}

function tokenSummary() {
  const now = Date.now();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const z = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, replies: 0 });
  const add = (a, e) => { a.input += e.input; a.output += e.output; a.cacheWrite += e.cacheWrite; a.cacheRead += e.cacheRead; a.total += e.input + e.output + e.cacheWrite; a.replies++; };
  const out = { today: z(), window5h: z(), bySession: {}, days: {} };
  for (const e of usage.values()) {
    if (e.ts >= today.getTime()) add(out.today, e);
    if (e.ts >= now - 5 * 3600_000) add(out.window5h, e);
    if (e.sid) add((out.bySession[e.sid] ??= z()), e);
    const day = new Date(e.ts).toISOString().slice(0, 10);
    add((out.days[day] ??= z()), e);
  }
  return out;
}

ipcMain.handle('tokens:get', () => { scanTokens(); return tokenSummary(); });
setInterval(() => { if (win && !win.isDestroyed() && win.isVisible()) { scanTokens(); send('tokens:update', tokenSummary()); } }, 10_000).unref();

// ---------------------------------------------------------------- misc IPC

ipcMain.handle('clip:read', () => clipboard.readText());
ipcMain.handle('clip:write', (_e, t) => { clipboard.writeText(String(t)); return true; });
ipcMain.handle('open:external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  return false;
});

// ---------------------------------------------------------------- window

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

function serveApp(req) {
  const u = new URL(req.url);
  if (u.host === 'project') {
    // Images referenced by Markdown files, from the open project only.
    try { return net.fetch(pathToFileURL(inProject(decodeURIComponent(u.pathname.slice(1)))).toString()); }
    catch { return new Response('forbidden', { status: 403 }); }
  }
  const file = path.normalize(path.join(APP_DIR, decodeURIComponent(u.pathname)));
  if (!file.startsWith(APP_DIR + path.sep)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#0E0F12',
    title: 'meta',
    icon: path.join(APP_DIR, 'renderer', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#16181D', symbolColor: '#9AA1B2', height: 44 },
    webPreferences: { preload: path.join(APP_DIR, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.loadURL('app://ide/renderer/index.html');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('meta.ide'); // Windows notifications need this
  loadState();
  writeHooksFile();
  await startHookServer();
  protocol.handle('app', serveApp);
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a));
  if (arg) setProject(arg);
  else if (state.project) watchProject(state.project);
  createWindow();
});

// Feature modules get the pieces of the core they need.
require('./lib/workspace').init({
  get state() { return state; }, // loadState() replaces the object later, so read it live
  ipcMain, app, shell, clipboard, Notification, saveState, send, live, spawnSession, publicSession,
  inProject, inProjectOf, cleanEnv, workDir, getWin: () => win, appDir: APP_DIR, transcriptFile, conversationTail,
});

app.on('window-all-closed', () => {
  for (const l of live.values()) { try { l.proc.kill(); } catch { /* gone */ } }
  app.quit();
});
