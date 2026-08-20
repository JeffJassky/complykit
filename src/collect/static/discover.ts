import fs from 'node:fs';
import path from 'node:path';

// Repo-relative, .gitignore-aware source discovery. Deliberately simple: always
// skip build/vendor dirs, plus any bare directory name a top-level .gitignore
// lists. Full .gitignore semantics are not needed — the goal is "don't lint
// node_modules or dist", not a faithful ignore engine.

const ALWAYS_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.output', '.svelte-kit', '.comply', '.cache', 'out', 'vendor',
]);

export const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.html'];

export interface DiscoverOptions {
  cwd: string;
  include?: string[]; // substring filters (repo-relative)
  exclude?: string[];
}

export interface Discovered {
  root: string;
  files: string[]; // repo-relative
  byExt: Record<string, string[]>;
}

function gitignoreDirNames(root: string): Set<string> {
  const skip = new Set<string>();
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return skip;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const name = line.replace(/^\//, '').replace(/\/$/, '');
    if (name && !name.includes('/') && !name.includes('*')) skip.add(name);
  }
  return skip;
}

export function discover(opts: DiscoverOptions): Discovered {
  const root = path.resolve(opts.cwd);
  const skipDirs = new Set([...ALWAYS_SKIP, ...gitignoreDirNames(root)]);
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') {
        // Hidden dirs/files: skip except we still descend nothing hidden.
        if (e.isDirectory()) continue;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        walk(abs);
      } else if (SOURCE_EXTENSIONS.includes(path.extname(e.name))) {
        files.push(path.relative(root, abs));
      }
    }
  }
  walk(root);

  let filtered = files;
  if (opts.include?.length) filtered = filtered.filter((f) => opts.include!.some((i) => f.includes(i)));
  if (opts.exclude?.length) filtered = filtered.filter((f) => !opts.exclude!.some((x) => f.includes(x)));

  const byExt: Record<string, string[]> = {};
  for (const f of filtered) {
    const ext = path.extname(f);
    (byExt[ext] ??= []).push(f);
  }
  return { root, files: filtered.sort(), byExt };
}
