// Claude Code hook -> meta IDE. Claude runs this on UserPromptSubmit / PreToolUse /
// PostToolUse / Notification / Stop (see hooks.json, written by main.js). It forwards the
// event to the IDE so the session's tab can show working / needs you / done.
// It must never slow Claude down or break it: short timeout, always exit 0.
'use strict';
const http = require('node:http');

const url = process.env.META_HOOK_URL;
const tab = process.env.META_TAB;
const event = process.argv[2] || 'unknown';
if (!url || !tab) process.exit(0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; if (input.length > 65536) input = input.slice(0, 65536); });
process.stdin.on('end', send);
setTimeout(send, 400); // don't wait forever for stdin

let sent = false;
function send() {
  if (sent) return;
  sent = true;
  let payload = {};
  try { payload = JSON.parse(input); } catch { /* not JSON: ignore */ }
  const body = JSON.stringify({ tab, event, message: payload.message ?? '', sessionId: payload.session_id ?? '' });
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 800 });
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.on('response', (res) => { res.resume(); res.on('end', () => process.exit(0)); });
  req.end(body);
}
