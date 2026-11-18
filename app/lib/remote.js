// Remote + automation: phone check-in server (and read-only share links), live preview
// server for static sites, watch mode for tests, voice typing, daily recap, learning mode.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
const safeEq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function init(ctx) {
  const { ipcMain, bus, live, send } = ctx;
  const findSession = (id) => ctx.state.sessions.find((x) => x.id === id);
  const statusOf = (id) => live.get(id)?.status || 'paused';

  // ------------------------------------------------------------ phone check-in + share links
  // Off until you turn it on. Full access = the phone token (view + answer). A share link
  // carries its own token for one session and is read-only. Both are random 128-bit values.

  let phone = null; // { server, port, token, clients: Set }
  const shares = new Map(); // token -> sessionId (read-only)
  const viewers = new Map(); // sessionId -> Set(res)

  // Write to a live-update stream only while it's open; a phone can drop off at any time.
  const push = (res, msg) => { if (!res.writableEnded && !res.destroyed) res.write(msg); };
  bus.on('pty', (id, data) => {
    const set = viewers.get(id);
    if (!set) return;
    const msg = `event: data\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) push(res, msg);
  });
  bus.on('resize', (id, cols, rows) => {
    for (const res of viewers.get(id) || []) push(res, `event: resize\ndata: ${JSON.stringify({ cols, rows })}\n\n`);
  });
  bus.on('status', ({ session, status }) => {
    for (const res of phone?.clients || []) push(res, `event: status\ndata: ${JSON.stringify({ id: session.id, status })}\n\n`);
  });

  const KEYS = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', ctrlc: '\x03', '1': '1', '2': '2', '3': '3', y: 'y', n: 'n' };

  function handlePhone(req, res) {
    const u = new URL(req.url, 'http://x');
    const cookie = /(?:^|;\s*)meta_phone=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    const full = safeEq(u.searchParams.get('t'), phone.token) || safeEq(cookie, phone.token);
    const shareTok = u.pathname.startsWith('/s/') ? u.pathname.slice(3).split('/')[0] : (u.searchParams.get('s') || '');
    const shared = !full && shares.has(shareTok) ? shares.get(shareTok) : null;
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!full && !shared) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('Open the link shown in meta IDE.'); }
    if (u.searchParams.has('t')) {
      res.writeHead(302, { 'set-cookie': `meta_phone=${phone.token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
      return res.end();
    }
    const may = (id) => full || shared === id;

    // static files for the phone page
    if (u.pathname === '/' || u.pathname.startsWith('/s/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(ctx.appDir, 'renderer', 'phone.html')));
    }
    const assets = { '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', '/icon.png': 'renderer/icon.png' };
    if (assets[u.pathname]) {
      res.writeHead(200, { 'content-type': MIME[path.extname(u.pathname)] || 'application/octet-stream', 'cache-control': 'max-age=3600' });
      return res.end(fs.readFileSync(path.join(ctx.appDir, assets[u.pathname])));
    }

    if (u.pathname === '/api/me') return json(200, { full, session: shared });
    if (u.pathname === '/api/sessions') {
      const list = ctx.state.sessions.filter((s) => may(s.id)).map((s) => ({ id: s.id, name: s.name, project: path.basename(s.project), kind: s.kind, status: statusOf(s.id) }));
      return json(200, list);
    }
    let m = /^\/api\/stream\/([\w-]+)$/.exec(u.pathname);
    if (m && may(m[1])) {
      const l = live.get(m[1]);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: init\ndata: ${JSON.stringify({ buffer: l?.buffer.slice(-200_000) || '', cols: l?.cols || 120, rows: l?.rows || 32, status: statusOf(m[1]), running: !!l })}\n\n`);
      if (!viewers.has(m[1])) viewers.set(m[1], new Set());
      viewers.get(m[1]).add(res);
      res.on('error', () => viewers.get(m[1])?.delete(res));
      // The replayed history was drawn at several terminal sizes over time. Nudge the size by
      // one column and back so Claude redraws a clean, current screen for the new viewer.
      if (l && l.cols > 20) {
        try { l.proc.resize(l.cols - 1, l.rows); } catch { /* exited */ }
        setTimeout(() => { try { l.proc.resize(l.cols, l.rows); } catch { /* exited */ } }, 120);
      }
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); viewers.get(m[1])?.delete(res); });
      return;
    }
    if (u.pathname === '/api/events' && full) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': ok\n\n');
      const p = phone; // phone access can be turned off while this stream is open
      p.clients.add(res);
      res.on('error', () => p.clients.delete(res));
      req.on('close', () => p.clients.delete(res));
      return;
    }
    m = /^\/api\/input\/([\w-]+)$/.exec(u.pathname);
    if (m && req.method === 'POST') {
      if (!full) return json(403, { error: 'this link is read-only' });
      if (req.headers['x-meta'] !== '1') return json(403, { error: 'missing header' });
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
      req.on('end', () => {
        let b = {};
        try { b = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        const l = live.get(m[1]);
        if (!l) return json(409, { error: 'that session is not running; open it in the IDE' });
        if (typeof b.text === 'string' && b.text) l.proc.write(b.text);
        if (b.key && KEYS[b.key]) l.proc.write(KEYS[b.key]);
        else if (b.submit) l.proc.write('\r');
        l.lastActive = Date.now();
        json(200, { ok: true });
      });
      return;
    }
    json(404, { error: 'not found' });
  }

  function phoneInfo() {
    if (!phone) return { on: false };
    return { on: true, port: phone.port, urls: lanIps().map((ip) => `http://${ip}:${phone.port}/?t=${phone.token}`) };
  }
  ipcMain.handle('phone:get', () => phoneInfo());
  ipcMain.handle('phone:set', (_e, on) => new Promise((resolve, reject) => {
    if (!on) {
      if (phone) {
        for (const c of phone.clients) c.end();
        for (const set of viewers.values()) for (const v of set) v.end(); // drop watchers too
        viewers.clear();
        phone.server.closeAllConnections?.();
        phone.server.close();
        phone = null;
      }
      shares.clear();
      return resolve(phoneInfo());
    }
    if (phone) return resolve(phoneInfo());
    const token = crypto.randomBytes(16).toString('hex');
    const server = http.createServer((req, res) => { try { handlePhone(req, res); } catch (e) { res.writeHead(500); res.end(String(e.message)); } });
    server.on('error', reject);
    server.listen(ctx.state.settings?.phonePort || 4545, '0.0.0.0', () => {
      phone = { server, port: server.address().port, token, clients: new Set() };
      resolve(phoneInfo());
    });
  }));
  ipcMain.handle('share:create', (_e, id) => {
    if (!phone) throw new Error('turn on phone access first: share links use the same server');
    if (!findSession(id)) throw new Error('no such session');
    const tok = crypto.randomBytes(16).toString('hex');
    shares.set(tok, id);
    return lanIps().map((ip) => `http://${ip}:${phone.port}/s/${tok}`);
  });
  ipcMain.handle('share:revokeAll', () => { shares.clear(); return true; });

  // ------------------------------------------------------------ live preview (static sites)

  const previews = new Map(); // root -> { server, url }
  ipcMain.handle('preview:static', () => new Promise((resolve, reject) => {
    const root = ctx.state.project;
    if (!root) return reject(new Error('open a folder first'));
    if (previews.has(root)) return resolve(previews.get(root).url);
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      let file = path.resolve(root, rel || 'index.html');
      const r = path.relative(root, file);
      if (r.startsWith('..') || path.isAbsolute(r) || r.split(path.sep)[0] === '.git') { res.writeHead(403); return res.end(); }
      try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(buf);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      previews.set(root, { server, url });
      resolve(url);
    });
  }));

  // ------------------------------------------------------------ watch mode

  const watch = new Map(); // root -> { command, running, again, timer }
  function guessTestCommand(root) {
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^﻿/, ''));
      if (pj.scripts?.test && !/no test specified/.test(pj.scripts.test)) return 'npm test --silent';
    } catch { /* no package.json */ }
    if (fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'tests'))) return '.venv\\Scripts\\python -m pytest -q';
    if (fs.existsSync(path.join(root, 'gradlew.bat'))) return '.\\gradlew.bat test';
    return 'npm test --silent';
  }
  function runTests(root) {
    const w = watch.get(root);
    if (!w) return;
    if (w.running) { w.again = true; return; }
    w.running = true;
    send('watch:status', { root, running: true });
    const started = Date.now();
    const encoded = Buffer.from(w.command, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd: root, env: ctx.cleanEnv(), windowsHide: true });
    let out = '';
    const take = (d) => { out += d; if (out.length > 40000) out = out.slice(-20000); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const finish = (code) => {
      w.running = false;
      send('watch:result', { root, ok: code === 0, code, output: out.slice(-8000), ms: Date.now() - started, command: w.command });
      if (w.again) { w.again = false; setTimeout(() => runTests(root), 300); }
    };
    child.on('error', (e) => { out += e.message; finish(-1); });
    child.on('close', finish);
  }
  bus.on('files', ({ root, touched }) => {
    const w = watch.get(root);
    if (!w || !touched.some((f) => !/(^|\/)(\.meta|node_modules|dist|build|coverage)\//.test(f))) return;
    clearTimeout(w.timer);
    w.timer = setTimeout(() => runTests(root), 2500); // let a burst of edits finish first
  });
  ipcMain.handle('watch:get', () => {
    const root = ctx.state.project;
    const w = watch.get(root);
    return { on: !!w, command: w?.command || ctx.state.watchCommands?.[root] || guessTestCommand(root || '.') };
  });
  ipcMain.handle('watch:set', (_e, { on, command }) => {
    const root = ctx.state.project;
    if (!root) throw new Error('open a folder first');
    if (!on) { watch.delete(root); return { on: false }; }
    const cmd = String(command || '').trim() || guessTestCommand(root);
    (ctx.state.watchCommands ??= {})[root] = cmd;
    ctx.saveState();
    watch.set(root, { command: cmd, running: false, again: false, timer: null });
    runTests(root);
    return { on: true, command: cmd };
  });

  // ------------------------------------------------------------ voice typing
  // Windows' own voice typing (Win+H) types into whatever has focus: the terminal.

  ipcMain.handle('voice:start', () => new Promise((resolve) => {
    const ps = `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);';
[W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero); [W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero);
[W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero); [W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true }, () => resolve(true));
  }));

  // ------------------------------------------------------------ Claude one-shot helper (Haiku)

  function claudeOnce(prompt, input) {
    return new Promise((resolve, reject) => {
      const exe = ctx.whichClaude();
      if (!exe) return reject(new Error('Claude Code was not found on PATH'));
      const child = spawn(exe, ['-p', prompt, '--model', 'haiku', '--output-format', 'text'], { cwd: ctx.state.project || os.homedir(), env: ctx.cleanEnv() });
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(err.trim().split('\n').pop() || 'Claude gave no answer'))));
      child.stdin.end(String(input || '').slice(0, 80000));
    });
  }

  // ------------------------------------------------------------ daily recap

  ipcMain.handle('recap:today', () => {
    const base = path.join(os.homedir(), '.claude', 'projects');
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const sessions = [];
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { return '# Today\n\nNo Claude sessions yet today.'; }
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(base, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = path.join(base, d, f);
        try { if (fs.statSync(file).mtimeMs < start.getTime()) continue; } catch { continue; }
        let first = '', cwd = '', prompts = 0, t0 = 0, t1 = 0;
        const edited = new Set();
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes('"timestamp"')) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          const at = Date.parse(o.timestamp) || 0;
          if (at < start.getTime() || o.isSidechain) continue;
          t0 ||= at; t1 = at; cwd ||= o.cwd || '';
          const c = o.message?.content;
          if (o.type === 'user') {
            const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
            if (t && !t.startsWith('<')) { prompts++; first ||= t.replace(/\s+/g, ' ').slice(0, 140); }
          } else if (o.type === 'assistant' && Array.isArray(c)) {
            for (const p of c) if (p.type === 'tool_use' && ['Write', 'Edit', 'MultiEdit'].includes(p.name) && p.input?.file_path) edited.add(p.input.file_path);
          }
        }
        if (prompts) sessions.push({ cwd, first, prompts, t0, t1, edited: [...edited] });
      }
    }
    if (!sessions.length) return `# ${start.toDateString()}\n\nNo Claude sessions yet today.`;
    sessions.sort((a, b) => a.t0 - b.t0);
    const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const byProject = new Map();
    for (const s of sessions) { const k = s.cwd || 'unknown'; if (!byProject.has(k)) byProject.set(k, []); byProject.get(k).push(s); }
    let md = `# ${start.toDateString()}\n\n${sessions.length} sessions · ${sessions.reduce((n, s) => n + s.prompts, 0)} prompts · ${new Set(sessions.flatMap((s) => s.edited)).size} files edited\n`;
    for (const [proj, list] of byProject) {
      md += `\n## ${path.basename(proj)}\n\n`;
      for (const s of list) {
        md += `- **${time(s.t0)}–${time(s.t1)}** · ${s.prompts} prompt${s.prompts > 1 ? 's' : ''}: ${s.first.replace(/[*_`[\]]/g, '')}\n`;
        if (s.edited.length) md += `  - edited: ${s.edited.slice(0, 8).map((f) => '`' + path.relative(proj, f).replace(/\\/g, '/') + '`').join(', ')}${s.edited.length > 8 ? ` and ${s.edited.length - 8} more` : ''}\n`;
      }
    }
    return md;
  });
  ipcMain.handle('recap:summarize', (_e, md) => claudeOnce(
    'Below is a log of my Claude Code sessions today. Write a short end-of-day recap in Markdown: what got done, what is still open, and one suggestion for tomorrow. Be concrete and brief. Output only the recap.', md));

  // ------------------------------------------------------------ task board (per project)

  ipcMain.handle('board:get', () => (ctx.state.board ??= {})[ctx.state.project] ?? []);
  ipcMain.handle('board:set', (_e, cards) => {
    if (!ctx.state.project || !Array.isArray(cards)) throw new Error('bad board');
    (ctx.state.board ??= {})[ctx.state.project] = cards.slice(0, 300).map((c) => ({
      id: String(c.id || crypto.randomUUID()), text: String(c.text || '').slice(0, 4000),
      col: ['ideas', 'doing', 'done'].includes(c.col) ? c.col : 'ideas', sessionId: c.sessionId || null, at: Number(c.at) || Date.now(),
    }));
    ctx.saveState();
    return ctx.state.board[ctx.state.project];
  });

  // ------------------------------------------------------------ learning mode

  ipcMain.handle('learn:explain', (_e, claudeId) => {
    const tail = ctx.conversationTail(claudeId, 12000);
    if (!tail) throw new Error('this tab has no conversation yet');
    return claudeOnce(
      'I am learning software engineering while building with Claude Code. Below is the end of one of my sessions. ' +
      'Explain in Markdown, for a learner: 1) what was done, in plain words; 2) why it was done that way; ' +
      '3) the software or system design idea behind each important choice (name it, one or two lines each); ' +
      '4) one thing worth reading about next. Keep it under 300 words. Output only the explanation.', tail);
  });
}

module.exports = { init };
