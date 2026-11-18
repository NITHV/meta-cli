import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function root(cwd: string): string {
  try {
    return resolve(git(cwd, 'rev-parse', '--show-toplevel')); // native separators on Windows
  } catch {
    throw new Error('not inside a git repository. cd into a repo, or run `git init` first');
  }
}

export function head(root: string): string {
  try {
    return git(root, 'rev-parse', 'HEAD');
  } catch {
    throw new Error('repository has no commits yet. Agents start from HEAD, so commit first: git add -A; git commit -m "init"');
  }
}

export function isDirty(root: string): boolean {
  try { git(root, 'update-index', '-q', '--refresh'); } catch { /* refresh reports dirty files via exit code */ }
  return git(root, 'status', '--porcelain') !== '';
}

/** Keep .meta/ out of `git status` without touching the user's .gitignore. */
export function excludeMeta(root: string): void {
  const p = resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
  const current = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (current.split(/\r?\n/).includes('.meta/')) return;
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, (current && !current.endsWith('\n') ? '\n' : '') + '.meta/\n');
}

export function addWorktree(root: string, id: string, base: string): { path: string; branch: string } {
  const path = join(root, '.meta', 'worktrees', id);
  const branch = `meta/${id}`;
  git(root, 'worktree', 'add', '-q', '-b', branch, path, base);
  return { path, branch };
}

/** Commit everything the agent changed. Returns false if nothing changed. */
export function commitAll(path: string, message: string): boolean {
  git(path, 'add', '-A');
  if (git(path, 'status', '--porcelain') === '') return false;
  git(path, '-c', 'user.name=meta-cli', '-c', 'user.email=meta-cli@localhost', 'commit', '-q', '-m', message);
  return true;
}

export function changedFiles(root: string, base: string, branch: string): string[] {
  const out = git(root, 'diff', '--name-only', base, branch);
  return out ? out.split('\n') : [];
}

/** Tracked + untracked (not ignored) files, forward-slash paths relative to root. */
export function listFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\0').filter(Boolean);
}

/** File content at a revision, or null if it doesn't exist there. Not trimmed. */
export function showFile(root: string, rev: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function shortHead(root: string): string {
  return git(root, 'rev-parse', '--short', 'HEAD');
}

export function shortstat(root: string, base: string, branch: string): string {
  return git(root, 'diff', '--shortstat', base, branch);
}

export function showDiff(root: string, base: string, branch: string): number {
  return spawnSync('git', ['diff', base, branch], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

export function squashInto(root: string, branch: string): number {
  return spawnSync('git', ['merge', '--squash', branch], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

export function remove(root: string, path: string, branch: string): void {
  try { git(root, 'worktree', 'remove', '--force', path); } catch { /* already gone */ }
  try { git(root, 'worktree', 'prune'); } catch { /* ignore */ }
  try { git(root, 'branch', '-D', branch); } catch { /* already gone */ }
}
