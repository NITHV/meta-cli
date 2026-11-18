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
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const pty = require('@lydell/node-pty');
const MarkdownIt = require('markdown-it');

const APP_DIR = __dirname;
let win = null;

// ---------------------------------------------------------------- state

const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
let state = { recent: [], project: null, sessions: [], active: {} };

function loadState() {
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')) }; } catch { /* first run */ }
  state.recent = state.recent.filter((p) => fs.existsSync(p));
  if (state.project && !fs.existsSync(state.project)) state.project = null;
}
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2));
  }, 200);
}
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const publicSession = (s) => {
  const l = live.get(s.id);
  return { id: s.id, project: s.project, name: s.name, kind: s.kind, claudeId: s.claudeId, createdAt: s.createdAt,
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
      PreToolUse: [{ matcher: '*', hooks: cmd('working') }],
      PostToolUse: [{ matcher: '*', hooks: cmd('working') }],
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
        res.writeHead(204); res.end();
        try { onHook(JSON.parse(body)); } catch { /* ignore bad payloads */ }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      hookUrl = `http://127.0.0.1:${server.address().port}/hook?k=${hookSecret}`;
      resolve();
    });
  });
}

function onHook({ tab, event, message }) {
  const l = live.get(tab);
  if (!l) return;
  if (event === 'working') setStatus(tab, 'working');
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
    args.push(...(transcriptExists(s.claudeId) ? ['--resume', s.claudeId] : ['--session-id', s.claudeId]));
    if (prompt) args.push(prompt);
  } else {
    file = 'powershell.exe';
    args = ['-NoLogo'];
  }
  const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: s.project, env, useConpty: true });
  const l = { proc, buffer: '', status: 'idle', pending: '', timer: null };
  live.set(s.id, l);
  proc.onData((d) => {
    l.buffer += d;
    if (l.buffer.length > MAX_BUFFER) l.buffer = l.buffer.slice(-MAX_BUFFER);
    l.pending += d;
    // Batch output into ~60 fps frames: far fewer IPC messages than one per chunk.
    l.timer ??= setTimeout(() => { send('pty:data', { id: s.id, data: l.pending }); l.pending = ''; l.timer = null; }, 16);
  });
  proc.onExit(({ exitCode }) => {
    if (l.timer) { clearTimeout(l.timer); send('pty:data', { id: s.id, data: l.pending }); }
    live.delete(s.id);
    send('pty:exit', { id: s.id, exitCode });
    send('session:status', { id: s.id, status: 'paused' });
  });
  send('session:status', { id: s.id, status: 'idle' });
  return l;
}

ipcMain.handle('session:create', (_e, { kind = 'claude', name, prompt, cols = 120, rows = 32 } = {}) => {
  if (!state.project) throw new Error('open a folder first');
  const count = state.sessions.filter((x) => x.project === state.project && x.kind === kind).length;
  const s = {
    id: crypto.randomUUID(),
    project: state.project,
    kind,
    name: (name || (kind === 'claude' ? `claude ${count + 1}` : `shell ${count + 1}`)).slice(0, 40),
    claudeId: crypto.randomUUID(),
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
  if (!l) l = spawnSession(s, cols, rows); // paused tab: resume it now (idle tabs cost no RAM)
  else try { l.proc.resize(cols, rows); } catch { /* exited */ }
  // The buffer already contains any output still waiting to be flushed: drop it so it isn't shown twice.
  if (l.timer) { clearTimeout(l.timer); l.timer = null; }
  l.pending = '';
  return { buffer: l.buffer, status: l.status };
});

ipcMain.on('session:write', (_e, id, data) => live.get(id)?.proc.write(data));
ipcMain.on('session:resize', (_e, id, cols, rows) => {
  if (cols > 0 && rows > 0) try { live.get(id)?.proc.resize(cols, rows); } catch { /* exited */ }
});
ipcMain.on('session:active', (_e, id) => { if (state.project) { state.active[state.project] = id; saveState(); } });

ipcMain.handle('session:close', (_e, id) => {
  const l = live.get(id);
  if (l) { try { l.proc.kill(); } catch { /* gone */ } live.delete(id); }
  state.sessions = state.sessions.filter((x) => x.id !== id);
  saveState();
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

app.on('window-all-closed', () => {
  for (const l of live.values()) { try { l.proc.kill(); } catch { /* gone */ } }
  app.quit();
});
