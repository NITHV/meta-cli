// Content features: save edited files, live Markdown preview, PDF export, per-tab notes,
// prompt history across projects, per-session stats, and title bar theming.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function init(ctx) {
  const { ipcMain } = ctx;

  // ------------------------------------------------------------ edit + preview

  ipcMain.handle('fs:write', (_e, rel, content) => {
    if (typeof content !== 'string') throw new Error('nothing to save');
    const abs = ctx.inProject(rel);
    fs.writeFileSync(abs, content);
    return fs.statSync(abs).mtimeMs;
  });

  ipcMain.handle('md:render', (_e, text) => ctx.renderMarkdown(String(text || '')));

  // ------------------------------------------------------------ PDF export
  // The window sends the fully rendered document (diagrams already drawn as SVG);
  // we print it in a hidden window with a light, print-friendly stylesheet.

  ipcMain.handle('export:pdf', async (_e, rel, bodyHtml) => {
    const abs = ctx.inProject(rel);
    const win = ctx.getWin();
    const r = await ctx.dialog.showSaveDialog(win, {
      defaultPath: abs.replace(/\.(md|markdown|mdx)$/i, '') + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return null;
    const css = `
      body { font: 11pt/1.6 "Segoe UI", sans-serif; color: #1d2330; margin: 0; }
      main { max-width: 720px; margin: 0 auto; }
      h1, h2, h3 { color: #111; line-height: 1.25; } h1 { font-size: 22pt; } h2 { font-size: 15pt; margin-top: 1.4em; }
      code { font: 9.5pt Consolas, monospace; background: #f0f2f5; padding: 1px 4px; border-radius: 3px; }
      pre { background: #f6f7f9; border: 1px solid #e2e5ea; border-radius: 6px; padding: 10px 12px; overflow: hidden; white-space: pre-wrap; }
      pre code { background: none; padding: 0; }
      table { border-collapse: collapse; } th, td { border: 1px solid #d5d9e0; padding: 4px 8px; } th { background: #f0f2f5; }
      blockquote { border-left: 3px solid #d5d9e0; margin: 0; padding: 2px 12px; color: #4a5263; }
      img, svg { max-width: 100%; } .copy { display: none; } li.task { list-style: none; }
      .mermaid-src { text-align: center; margin: 1em 0; }
      [class^="tk-"] { color: inherit; }`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main>${bodyHtml}</main></body></html>`;
    const tmp = path.join(os.tmpdir(), `meta-export-${Date.now()}.html`);
    fs.writeFileSync(tmp, html);
    const { BrowserWindow } = require('electron');
    const pw = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
    try {
      await pw.loadFile(tmp);
      const pdf = await pw.webContents.printToPDF({ printBackground: true, margins: { marginType: 'default' }, pageSize: 'A4' });
      fs.writeFileSync(r.filePath, pdf);
    } finally {
      pw.destroy();
      fs.rmSync(tmp, { force: true });
    }
    ctx.shell.showItemInFolder(r.filePath);
    return r.filePath;
  });

  // ------------------------------------------------------------ notes per tab

  const notesFile = (id) => path.join(ctx.app.getPath('userData'), 'notes', `${String(id).replace(/[^\w-]/g, '')}.md`);
  ipcMain.handle('notes:get', (_e, id) => { try { return fs.readFileSync(notesFile(id), 'utf8'); } catch { return ''; } });
  ipcMain.handle('notes:set', (_e, id, text) => {
    fs.mkdirSync(path.dirname(notesFile(id)), { recursive: true });
    fs.writeFileSync(notesFile(id), String(text ?? ''));
    return true;
  });

  // ------------------------------------------------------------ prompt history
  // Every prompt you typed into Claude, in any project, newest first. Read from
  // Claude's transcripts; cached per file by modification time.

  const histCache = new Map(); // file -> { mtime, prompts: [{ text, at, project }] }
  ipcMain.handle('history:list', () => {
    const base = path.join(os.homedir(), '.claude', 'projects');
    const all = [];
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { return []; }
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(base, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = path.join(base, d, f);
        let st;
        try { st = fs.statSync(file); } catch { continue; }
        let c = histCache.get(file);
        if (!c || c.mtime !== st.mtimeMs) {
          const prompts = [];
          let text = '';
          try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
          for (const line of text.split('\n')) {
            if (!line.includes('"type":"user"')) continue;
            let o;
            try { o = JSON.parse(line); } catch { continue; }
            if (o.type !== 'user' || o.isSidechain || o.isMeta) continue;
            const content = o.message?.content;
            const t = typeof content === 'string' ? content
              : Array.isArray(content) && content.every((p) => p.type === 'text') ? content.map((p) => p.text).join('\n') : '';
            if (!t.trim() || t.startsWith('<') || t.startsWith('This continues an earlier session')) continue;
            prompts.push({ text: t.slice(0, 4000), at: Date.parse(o.timestamp) || st.mtimeMs, project: o.cwd || '' });
          }
          c = { mtime: st.mtimeMs, prompts };
          histCache.set(file, c);
        }
        all.push(...c.prompts);
      }
    }
    const seen = new Set();
    return all.sort((a, b) => b.at - a.at).filter((p) => {
      const k = p.text.trim();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 500);
  });

  // ------------------------------------------------------------ session stats ("cost of a task")

  ipcMain.handle('stats:session', (_e, claudeId) => {
    const f = ctx.transcriptFile(claudeId);
    if (!f) return null;
    let prompts = 0, replies = 0, tools = 0, first = 0, last = 0;
    const ids = new Set();
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"type"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain) continue;
      const at = Date.parse(o.timestamp) || 0;
      if (at) { first ||= at; last = at; }
      if (o.type === 'user') {
        const c = o.message?.content;
        if (typeof c === 'string' ? !c.startsWith('<') : Array.isArray(c) && c.some((p) => p.type === 'text')) prompts++;
      } else if (o.type === 'assistant') {
        const id = o.message?.id;
        if (id && !ids.has(id)) { ids.add(id); replies++; }
        for (const p of o.message?.content || []) if (p.type === 'tool_use') tools++;
      }
    }
    return { prompts, replies, tools, minutes: first && last ? Math.round((last - first) / 60000) : 0, first, last };
  });

  // ------------------------------------------------------------ theme (title bar overlay)

  ipcMain.handle('theme:titlebar', (_e, color, symbolColor) => {
    const win = ctx.getWin();
    const ok = (c) => /^#[0-9a-f]{6}$/i.test(c);
    if (win && ok(color) && ok(symbolColor)) {
      win.setTitleBarOverlay({ color, symbolColor, height: 45 });
      // Mica follows the native theme, so keep it in step with the app's own theme.
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
      const want = r * 0.3 + g * 0.59 + b * 0.11 > 140 ? 'light' : 'dark';
      const nt = require('electron').nativeTheme;
      if (nt.themeSource !== want) {
        nt.themeSource = want;
        // Mica only in dark mode: in light mode it hides the page (see createWindow).
        if (want === 'light') { win.setBackgroundMaterial('none'); win.setBackgroundColor('#F7F6F8'); }
        else { win.setBackgroundColor('#00000000'); win.setBackgroundMaterial('mica'); }
        win.webContents.invalidate();
      }
    }
    return true;
  });
}

module.exports = { init };
