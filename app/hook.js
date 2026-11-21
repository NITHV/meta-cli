// Claude Code hook -> Tando. Claude runs this on UserPromptSubmit / PreToolUse /
// PostToolUse / Notification / Stop (see hooks.json, written by main.js). It forwards the
// event to the IDE so the tab shows working / needs you / done, and so the IDE can
// snapshot a file just before Claude edits it (that's how per-session diffs work).
// It must never break Claude: short timeout, always exit 0.
'use strict';
const http = require('node:http');

const url = process.env.META_HOOK_URL;
const tab = process.env.META_TAB;
const event = process.argv[2] || 'unknown';
if (!url || !tab) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; if (input.length > 262144) input = input.slice(0, 262144); });
process.stdin.on('end', send);
setTimeout(send, 400); // don't wait forever for stdin

let sent = false;
function send() {
  if (sent) return;
  sent = true;
  let p = {};
  try { p = JSON.parse(input); } catch { /* not JSON: ignore */ }
  const ti = p.tool_input || {};
  const body = JSON.stringify({
    tab,
    event,
    message: p.message ?? '',
    sessionId: p.session_id ?? '',
    tool: p.tool_name ?? '',
    file: ti.file_path || ti.notebook_path || '',
  });
  // PreToolUse waits for the reply, so the IDE's snapshot happens before the edit.
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 1500 });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('response', (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.end(body);
}
