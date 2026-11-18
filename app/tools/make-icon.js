// Renders the meta logo to PNGs with an offscreen Electron window and packs them into
// renderer/icon.ico (PNG-compressed ICO, supported since Windows Vista) + renderer/icon.png.
// Run: node_modules\electron\dist\electron.exe tools\make-icon.js
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZES = [256, 64, 48, 32, 16];
const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 64 64">
  <rect x="2" y="2" width="60" height="60" rx="15" fill="#F28C4B"/>
  <text x="32" y="45" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="38" fill="#1A0F08">m</text>
</svg>`;

app.whenReady().then(async () => {
  // Render once at 256 px, then scale down for the smaller sizes.
  const tmp = path.join(app.getPath('temp'), 'meta-icon.html');
  fs.writeFileSync(tmp, `<html><body style="margin:0;background:transparent">${svg(256)}</body></html>`);
  const win = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 300));
  const big = await win.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  win.destroy();
  fs.rmSync(tmp, { force: true });
  const pngs = SIZES.map((s) => ({ s, buf: (s === 256 ? big : big.resize({ width: s, height: s, quality: 'best' })).toPNG() }));
  // ICO: 6-byte header, 16-byte entry per image, then the PNG data.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ s, buf }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
    offset += buf.length;
    return e;
  });
  const out = path.join(__dirname, '..', 'renderer');
  fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]));
  fs.writeFileSync(path.join(out, 'icon.png'), pngs[0].buf);
  console.log('wrote renderer/icon.ico and renderer/icon.png');
  app.quit();
});
