// Workspace features: isolated sessions (git worktree + branch + PR), image paste,
// open in VS Code, package.json script buttons, port monitor, and the RAM saver.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');

function init(ctx) {
  const { ipcMain, send, live } = ctx;
  const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 << 20, ...opts });
  const errOf = (e) => new Error(String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-4).join('\n'));
  const findSession = (id) => ctx.state.sessions.find((x) => x.id === id);

  /** Keep .meta/ (worktrees, pasted images) out of git status, without touching .gitignore. */
  function excludeMeta(root) {
    try {
      const p = path.resolve(root, git(root, ['rev-parse', '--git-path', 'info/exclude']).trim());
      const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes('.meta/')) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.appendFileSync(p, (cur && !cur.endsWith('\n') ? '\n' : '') + '.meta/\n');
      }
    } catch { /* not a git repo: nothing to exclude from */ }
  }

  // ------------------------------------------------------------ isolated sessions
  // A Claude tab on its own branch in its own worktree: parallel sessions can't
  // overwrite each other. Apply squashes it into your working tree; or open a PR.

  ipcMain.handle('session:createIsolated', (_e, { name, model = '', cols = 120, rows = 32 } = {}) => {
    const project = ctx.state.project;
    if (!project) throw new Error('open a folder first');
    let base;
    try { base = git(project, ['rev-parse', 'HEAD']).trim(); } catch { throw new Error('isolated sessions need a git repo with at least one commit'); }
    const slug = String(name || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';
    const tag = crypto.randomBytes(2).toString('hex');
    const branch = `meta/${slug}-${tag}`;
    const dir = path.join(project, '.meta', 'worktrees', `${slug}-${tag}`);
    excludeMeta(project);
    try { git(project, ['worktree', 'add', '-q', '-b', branch, dir, base]); } catch (e) { throw errOf(e); }
    const s = {
      id: crypto.randomUUID(), project, cwd: dir, kind: 'claude', name: (name || `isolated ${slug}`).slice(0, 40),
      claudeId: crypto.randomUUID(), model: /^[\w.:-]*$/.test(model) ? model : '', createdAt: Date.now(),
      isolated: { branch, base, dir },
    };
    ctx.state.sessions.push(s);
    ctx.state.active[project] = s.id;
    ctx.saveState();
    ctx.spawnSession(s, cols, rows);
    return ctx.publicSession(s);
  });

  function commitWorktree(s, message) {
    const dir = s.isolated.dir;
    git(dir, ['add', '-A']);
    if (git(dir, ['status', '--porcelain']).trim()) {
      git(dir, ['-c', 'user.name=Tando', '-c', 'user.email=tando@localhost', 'commit', '-q', '-m', message]);
    }
    return git(s.project, ['diff', '--name-only', s.isolated.base, s.isolated.branch]).split('\n').filter(Boolean);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function removeIsolated(s) {
    const l = live.get(s.id);
    if (l) {
      const exited = new Promise((r) => l.proc.onExit(() => r()));
      try { l.proc.kill(); } catch { /* gone */ }
      await Promise.race([exited, sleep(3000)]); // Windows keeps the folder locked while the process lives
      live.delete(s.id);
    }
    ctx.state.sessions = ctx.state.sessions.filter((x) => x.id !== s.id);
    ctx.saveState();
    for (let i = 0; i < 6 && fs.existsSync(s.isolated.dir); i++) {
      try { git(s.project, ['worktree', 'remove', '--force', s.isolated.dir]); } catch { /* still locked */ }
      if (fs.existsSync(s.isolated.dir)) {
        try { fs.rmSync(s.isolated.dir, { recursive: true, force: true }); } catch { /* still locked */ }
      }
      if (fs.existsSync(s.isolated.dir)) await sleep(500);
    }
    try { git(s.project, ['worktree', 'prune']); } catch { /* ignore */ }
    try { git(s.project, ['branch', '-D', s.isolated.branch]); } catch { /* ignore */ }
  }

  ipcMain.handle('isolated:info', (_e, id) => {
    const s = findSession(id);
    if (!s?.isolated) return null;
    let files = [];
    try { commitWorktree(s, `Tando: ${s.name}`); files = git(s.project, ['diff', '--name-only', s.isolated.base, s.isolated.branch]).split('\n').filter(Boolean); } catch { /* ignore */ }
    return { branch: s.isolated.branch, files };
  });

  ipcMain.handle('isolated:apply', async (_e, id) => {
    const s = findSession(id);
    if (!s?.isolated) throw new Error('not an isolated session');
    const files = commitWorktree(s, `Tando: ${s.name}`);
    if (!files.length) throw new Error('this session has no changes to apply');
    try { git(s.project, ['merge', '--squash', s.isolated.branch]); } catch (e) { throw errOf(e); }
    await removeIsolated(s);
    return { files };
  });

  ipcMain.handle('isolated:discard', async (_e, id) => {
    const s = findSession(id);
    if (!s?.isolated) throw new Error('not an isolated session');
    await removeIsolated(s);
    return true;
  });

  ipcMain.handle('isolated:pr', async (_e, id) => {
    const s = findSession(id);
    if (!s?.isolated) throw new Error('not an isolated session');
    const files = commitWorktree(s, `Tando: ${s.name}`);
    if (!files.length) throw new Error('nothing to put in a PR yet');
    const env = ctx.cleanEnv();
    try { git(s.isolated.dir, ['push', '-u', 'origin', s.isolated.branch], { env }); } catch (e) { throw errOf(e); }
    return new Promise((resolve, reject) => {
      execFile('gh', ['pr', 'create', '--fill', '--head', s.isolated.branch], { cwd: s.isolated.dir, env }, (err, stdout, stderr) => {
        const url = String(stdout).match(/https:\/\/\S+/)?.[0];
        if (url) { ctx.shell.openExternal(url); return resolve(url); }
        reject(new Error(String(stderr || err?.message || 'gh pr create failed').trim()));
      });
    });
  });

  // ------------------------------------------------------------ image paste
  // Save a clipboard image under .meta/pastes/ and hand back a path to mention.

  /** PNG bytes of a clipboard image, or null. Electron 45 replaced readImage() with async read(). */
  async function clipboardPng() {
    const cb = ctx.clipboard;
    if (typeof cb.readImage === 'function') {
      const img = cb.readImage();
      return img.isEmpty() ? null : img.toPNG();
    }
    if (!cb.has('image/png')) return null;
    for (const item of await cb.read()) {
      if (!item.types.includes('image/png')) continue;
      const blob = await item.getType('image/png');
      return Buffer.from(await blob.arrayBuffer());
    }
    return null;
  }

  ipcMain.handle('clip:saveImage', async (_e, sessionId) => {
    const png = await clipboardPng();
    if (!png) return null;
    const s = findSession(sessionId);
    const root = s ? ctx.workDir(s) : ctx.state.project; // an isolated tab works in its own worktree
    if (!root) throw new Error('open a folder first');
    const dir = path.join(root, '.meta', 'pastes');
    fs.mkdirSync(dir, { recursive: true });
    excludeMeta(s?.project || root);
    const name = `paste-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
    fs.writeFileSync(path.join(dir, name), png);
    return `.meta/pastes/${name}`;
  });

  // ------------------------------------------------------------ open in VS Code

  let codeExe;
  function findCode() {
    if (codeExe !== undefined) return codeExe;
    codeExe = null;
    try {
      const cmd = execFileSync('where.exe', ['code.cmd'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
      const exe = cmd && path.join(path.dirname(cmd), '..', 'Code.exe');
      if (exe && fs.existsSync(exe)) codeExe = exe;
    } catch { /* not installed */ }
    if (!codeExe) {
      const guess = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
      if (fs.existsSync(guess)) codeExe = guess;
    }
    return codeExe;
  }
  ipcMain.handle('open:vscode', (_e, rel, line = 0) => {
    const exe = findCode();
    if (!exe) throw new Error('VS Code was not found');
    const abs = ctx.inProject(rel);
    const { spawn } = require('node:child_process');
    spawn(exe, ['-g', line ? `${abs}:${line}` : abs], { detached: true, stdio: 'ignore' }).unref();
    return true;
  });
  ipcMain.handle('open:vscodeAvailable', () => !!findCode());

  // ------------------------------------------------------------ package.json scripts

  ipcMain.handle('scripts:list', () => {
    const project = ctx.state.project;
    if (!project) return [];
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8').replace(/^﻿/, '')); // tolerate a BOM
      return Object.entries(pj.scripts || {}).map(([name, cmd]) => ({ name, cmd: String(cmd) })).slice(0, 30);
    } catch { return []; }
  });

  // ------------------------------------------------------------ port monitor
  // Listening TCP ports owned by processes the IDE's terminals started.

  function processTable() {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'], { encoding: 'utf8', maxBuffer: 16 << 20 });
    const rows = new Map();
    for (const line of out.split(/\r?\n/)) {
      const [pid, ppid, ...name] = line.split(',');
      if (pid) rows.set(Number(pid), { ppid: Number(ppid), name: name.join(',') });
    }
    return rows;
  }

  ipcMain.handle('ports:list', () => {
    const procs = processTable();
    const roots = new Map(); // pid -> session name
    for (const [id, l] of live) roots.set(l.proc.pid, findSession(id)?.name || 'session');
    const owner = (pid) => {
      for (let p = pid, hops = 0; p && hops < 30; p = procs.get(p)?.ppid, hops++) if (roots.has(p)) return roots.get(p);
      return null;
    };
    const net = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const seen = new Set();
    const ports = [];
    for (const line of net.split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (!m) continue;
      const [, host, port, pidStr] = m;
      const pid = Number(pidStr);
      const session = owner(pid);
      if (!session || seen.has(port)) continue;
      seen.add(port);
      ports.push({ port: Number(port), host, pid, name: procs.get(pid)?.name || '?', session });
    }
    return ports.sort((a, b) => a.port - b.port);
  });

  ipcMain.handle('ports:kill', (_e, pid) => {
    // Only processes started from an IDE terminal can be stopped from here.
    const procs = processTable();
    const roots = new Set([...live.values()].map((l) => l.proc.pid));
    let ok = false;
    for (let p = Number(pid), hops = 0; p && hops < 30; p = procs.get(p)?.ppid, hops++) if (roots.has(p) && p !== Number(pid)) { ok = true; break; }
    if (!ok) throw new Error('that process was not started from this IDE');
    execFileSync('taskkill.exe', ['/PID', String(Number(pid)), '/T', '/F'], { stdio: 'ignore' });
    return true;
  });

  // ------------------------------------------------------------ RAM saver
  // Idle Claude tabs (finished, untouched for a while, not on screen) are stopped;
  // clicking the tab resumes the same conversation with --resume.

  const SLEEP_AFTER = () => (ctx.state.settings?.sleepMinutes ?? 30) * 60_000;
  setInterval(() => {
    const limit = SLEEP_AFTER();
    if (limit <= 0) return;
    for (const [id, l] of live) {
      const s = findSession(id);
      if (!s || s.kind !== 'claude') continue;
      const onScreen = ctx.getWin()?.isFocused() && ctx.state.active[s.project] === id;
      const idle = l.status === 'done' || l.status === 'idle';
      if (idle && !onScreen && Date.now() - l.lastActive > limit && ctx.transcriptFile(s.claudeId)) {
        s.asleep = true;
        try { l.proc.kill(); } catch { /* gone */ }
      }
    }
  }, 60_000).unref();

  ipcMain.handle('settings:get', () => ({ sleepMinutes: 30, sound: true, ...(ctx.state.settings || {}) }));
  ipcMain.handle('settings:set', (_e, patch) => {
    const allowed = ['sleepMinutes', 'sound', 'theme'];
    ctx.state.settings = { ...(ctx.state.settings || {}) };
    for (const k of allowed) if (k in (patch || {})) ctx.state.settings[k] = patch[k];
    ctx.saveState();
    return ctx.state.settings;
  });

  ipcMain.handle('memory:info', () => ({
    running: [...live.values()].length,
    freeMb: Math.round(os.freemem() / 1048576),
    totalMb: Math.round(os.totalmem() / 1048576),
  }));
}

module.exports = { init };
