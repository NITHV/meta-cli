import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Short, human-readable summary of a tool call's input. */
export function toolDetail(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const d = input.command ?? input.file_path ?? input.absolute_path ?? input.path ?? input.dir_path
    ?? input.pattern ?? input.url ?? input.query ?? input.description;
  if (typeof d === 'string') return d;
  // Unknown schema (e.g. agy's PascalCase CommandLine / AbsolutePath): first string value.
  const firstString = Object.values(input).find((v) => typeof v === 'string');
  return typeof firstString === 'string' ? firstString : JSON.stringify(input);
}

export function oneLine(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 3) + '...' : one;
}

/** Version from `<bin> --version`, via a fixed command string (safe: no user input). */
export function versionOf(bin: string): string | null {
  const r = spawnSync(`${bin} --version`, { encoding: 'utf8', shell: true });
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
}

/**
 * Resolve an npm-installed CLI to `node <entry.js>`.
 * On Windows, npm installs `.cmd` shims, which can only be spawned through cmd.exe,
 * and cmd.exe would re-parse the task text: an injection risk. Running the package's
 * JS entry directly with node passes arguments verbatim.
 */
export function npmCommand(bin: string, pkg: string): { cmd: string; prefix: string[] } {
  if (process.platform !== 'win32') return { cmd: bin, prefix: [] };
  const where = spawnSync('where', [`${bin}.cmd`], { encoding: 'utf8' });
  for (const shim of where.stdout?.split(/\r?\n/).filter(Boolean) ?? []) {
    const pkgDir = join(dirname(shim), 'node_modules', ...pkg.split('/'));
    const pj = join(pkgDir, 'package.json');
    if (!existsSync(pj)) continue;
    const json = JSON.parse(readFileSync(pj, 'utf8'));
    const rel = typeof json.bin === 'string' ? json.bin : json.bin?.[bin];
    if (rel) return { cmd: process.execPath, prefix: [join(pkgDir, rel)] };
  }
  throw new Error(`could not locate the ${pkg} entry point; is it installed with npm -g?`);
}
