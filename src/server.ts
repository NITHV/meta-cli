import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { adapters } from './agents/index.ts';
import { openStore } from './store.ts';
import * as git from './git.ts';
import { applyRun, discardRun, newId, parseSpecs, pool, runOne } from './run.ts';

// `meta serve`: the same core as the CLI, exposed over HTTP + Server-Sent Events
// for the web IDE in ui/. Headless core, thin clients.

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const MAX_FILE = 2 * 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).unref();
}

export function serve(o: { port: number; host: string; open: boolean }): Promise<never> {
  const root = git.root(process.cwd());
  git.head(root); // fail early on a repo with no commits
  git.excludeMeta(root);
  const store = openStore(root);

  // Every request needs this token (cookie after the first visit). Without it, any web page
  // you open could POST to localhost and start agent runs: CSRF / DNS-rebinding defense.
  const token = randomBytes(16).toString('hex');
  const tokenBuf = Buffer.from(token);
  const authed = (req: IncomingMessage, url: URL) => {
    const cookie = /(?:^|;\s*)meta_token=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    return [url.searchParams.get('t'), cookie].some(
      (v) => !!v && v.length === token.length && timingSafeEqual(Buffer.from(v), tokenBuf),
    );
  };

  const agentInfo = adapters.map((a) => {
    const version = a.detect();
    return { name: a.name, version, hint: version ? a.setupHint?.() ?? null : null };
  });

  // Server-Sent Events: one-way push of run updates to every open tab.
  const clients = new Set<ServerResponse>();
  const send = (type: string, data: unknown) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000).unref();

  const safePath = (p: unknown): string => {
    if (typeof p !== 'string' || !p) throw new HttpError(400, 'path required');
    const abs = resolve(root, p);
    const rel = relative(root, abs);
    const top = rel.split(sep)[0];
    if (!rel || isAbsolute(rel) || rel.startsWith('..') || top === '.git' || top === '.meta') {
      throw new HttpError(403, 'path not allowed');
    }
    return abs;
  };

  const startRuns = (task: string, agentList: string[], yolo: boolean) => {
    const specs = parseSpecs(agentList.join(','));
    const ctx = { root, base: git.head(root), store };
    const raceId = specs.length > 1 ? newId() : undefined;
    const tasks = specs.map((spec) => async () => {
      let id = '';
      try {
        await runOne(ctx, spec, task, { yolo, raceId }, {
          onStart: (rid) => { id = rid; send('run', store.findRun(rid)); },
          onEvent: (rid, ev) => send('ev', { id: rid, ev }),
        });
      } catch (err) {
        send('toast', { message: `run failed to start: ${errMsg(err)}` });
      }
      if (id) send('run', store.findRun(id));
    });
    void pool(tasks, 2); // same concurrency cap as `meta race`
    return { raceId: raceId ?? null, count: specs.length };
  };

  async function serveStatic(pathname: string, res: ServerResponse) {
    const file = resolve(UI_DIR, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(UI_DIR + sep) || !existsSync(file)) throw new HttpError(404, 'not found');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!authed(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('unauthorized: open the URL printed by `meta serve`');
    }
    if (url.searchParams.has('t')) {
      // Swap the URL token for an HttpOnly, SameSite=Strict cookie, and drop it from the address bar.
      res.writeHead(302, { 'set-cookie': `meta_token=${token}; HttpOnly; SameSite=Strict; Path=/`, location: url.pathname });
      return res.end();
    }
    // Belt and braces: a custom header can't be sent cross-site without a CORS preflight we never answer.
    if (req.method !== 'GET' && req.headers['x-meta'] !== '1') throw new HttpError(403, 'missing X-Meta header');

    const p = url.pathname;
    if (!p.startsWith('/api/')) return serveStatic(p, res);

    if (p === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/info' && req.method === 'GET') {
      return json(res, { repo: basename(root), head: git.shortHead(root), dirty: git.isDirty(root), agents: agentInfo });
    }

    if (p === '/api/files' && req.method === 'GET') {
      return json(res, { files: git.listFiles(root).filter((f) => existsSync(join(root, f))) });
    }

    if (p === '/api/file') {
      if (req.method === 'GET') {
        const abs = safePath(url.searchParams.get('path'));
        if (!existsSync(abs)) throw new HttpError(404, 'no such file');
        if (statSync(abs).size > MAX_FILE) return json(res, { binary: true });
        const buf = await readFile(abs);
        if (buf.includes(0)) return json(res, { binary: true });
        return json(res, { content: buf.toString('utf8') });
      }
      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (typeof b.content !== 'string') throw new HttpError(400, 'content required');
        const abs = safePath(b.path);
        await writeFile(abs, b.content, 'utf8');
        return json(res, { ok: true });
      }
    }

    if (p === '/api/runs' && req.method === 'GET') return json(res, { runs: store.listRuns() });

    if (p === '/api/runs' && req.method === 'POST') {
      const b = await readBody(req);
      const task = typeof b.task === 'string' ? b.task.trim() : '';
      const agents = Array.isArray(b.agents) ? b.agents.filter((a: unknown) => typeof a === 'string') : [];
      if (!task) throw new HttpError(400, 'task required');
      if (!agents.length) throw new HttpError(400, 'pick at least one agent');
      try {
        return json(res, startRuns(task, agents, b.yolo === true));
      } catch (err) {
        throw new HttpError(400, errMsg(err));
      }
    }

    const m = /^\/api\/runs\/([a-z0-9]+)(?:\/(diff|apply|discard))?$/.exec(p);
    if (m) {
      const run = (() => { try { return store.findRun(m[1]); } catch (e) { throw new HttpError(404, errMsg(e)); } })();
      const action = m[2];
      if (!action && req.method === 'GET') return json(res, { run, events: store.events(run.id) });
      if (action === 'diff' && req.method === 'GET') {
        if (run.status === 'applied' || run.status === 'discarded') return json(res, { files: [], gone: true });
        const files = git.changedFiles(root, run.base, run.branch).map((path) => ({
          path,
          original: git.showFile(root, run.base, path) ?? '',
          modified: git.showFile(root, run.branch, path) ?? '',
        }));
        return json(res, { files });
      }
      if (action === 'apply' && req.method === 'POST') {
        try {
          const rivals = applyRun(root, store, run);
          send('run', store.findRun(run.id));
          send('files', {});
          return json(res, { ok: true, rivals: rivals.map((r) => r.id) });
        } catch (err) {
          throw new HttpError(409, errMsg(err));
        }
      }
      if (action === 'discard' && req.method === 'POST') {
        try {
          discardRun(root, store, run);
        } catch (err) {
          throw new HttpError(409, errMsg(err));
        }
        send('run', store.findRun(run.id));
        return json(res, { ok: true });
      }
    }

    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, { error: errMsg(err) }, status);
      else res.end();
    });
  });

  return new Promise((_, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) =>
      reject(err.code === 'EADDRINUSE' ? new Error(`port ${o.port} is in use; try --port ${o.port + 1}`) : err));
    server.listen(o.port, o.host, () => {
      const local = `http://localhost:${o.port}/?t=${token}`;
      console.log(`meta IDE for ${basename(root)}`);
      console.log(`  ${local}`);
      if (o.host === '0.0.0.0') for (const ip of lanAddresses()) console.log(`  http://${ip}:${o.port}/?t=${token}   (phone, same Wi-Fi)`);
      console.log('Ctrl+C to stop. The token in the URL is your key: don\'t share it.');
      if (o.open) openBrowser(local);
    });
    process.on('SIGINT', () => {
      console.log('\nstopping');
      setTimeout(() => process.exit(130), 300); // runner's SIGINT handlers kill agents first
    });
  });
}
