import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Finding } from '../record/index.js';

// Browser findings localize to a route + selector — the DOM has no file. But a
// Vue SFC with <style scoped> stamps every element with data-v-<hash>, and
// @vitejs/plugin-vue derives that hash deterministically: sha256 of the file
// path RELATIVE TO THE VITE ROOT, first 8 hex chars (dev mode; prod appends
// content, which we cannot reproduce — dev targets are what complykit scans).
//
// We don't know the vite root, so we hash EVERY path suffix of every .vue file
// in the repo ("Foo.vue", "views/Foo.vue", "src/views/Foo.vue", …) and build a
// scope-id → repo-relative-path map. Whatever the root is, one suffix matches.
// A finding whose evidence carries data-v-XXXXXXXX then gains subject.file —
// which makes group-by-file in the report cover browser findings, and hands an
// agent the actual component to fix.
//
// Fingerprint safety: for presence findings routePattern wins over file as the
// identity locus, so enriching file onto a route-bearing finding never changes
// its fingerprint.

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.comply']);

function walkVueFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walkVueFiles(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.vue')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** scope id ("24b21cfc") → repo-relative .vue path. Ambiguous hashes (two
 *  files' suffixes colliding — astronomically unlikely) are dropped. */
export function buildVueScopeMap(repoDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const clash = new Set<string>();
  for (const abs of walkVueFiles(repoDir)) {
    const rel = path.relative(repoDir, abs);
    const segs = rel.split(path.sep);
    for (let i = 0; i < segs.length; i++) {
      // posix + native separators: vite normalizes, but hash both to be safe.
      const variants = new Set([segs.slice(i).join('/'), segs.slice(i).join(path.sep)]);
      for (const v of variants) {
        const h = short(v);
        const existing = map.get(h);
        if (existing && existing !== rel) clash.add(h);
        else map.set(h, rel);
      }
    }
  }
  for (const h of clash) map.delete(h);
  return map;
}

const SCOPE_RE = /data-v-([0-9a-f]{7,8})/;

/** First data-v scope id found in a finding: an explicit details.vueScopeId
 *  (collector climbed the ancestor chain) beats scraping the locator/evidence
 *  text (which only sees the element's own attribute). */
function scopeIdOf(f: Finding): string | null {
  const d = f.details as { vueScopeId?: unknown } | undefined;
  if (typeof d?.vueScopeId === 'string' && /^[0-9a-f]{7,8}$/.test(d.vueScopeId)) return d.vueScopeId;
  const texts: Array<string | undefined> = [f.subject.locator?.cssPath, f.subject.locator?.name];
  for (const e of f.evidence) {
    if (e.kind === 'dom-snippet') texts.push(e.html);
  }
  for (const t of texts) {
    const m = t?.match(SCOPE_RE);
    if (m) return m[1];
  }
  return null;
}

export interface VueEnrichResult {
  components: number; // distinct files in the scope map
  enriched: number; // findings that gained subject.file
  relativized: number; // findings whose runtime-absolute path was repo-relativized
}

/** Mutates findings: (1) relativize a runtime-supplied absolute subject.file
 *  (Vue's __file is a filesystem path) against the repo; (2) for findings still
 *  without a file, resolve their Vue scope id to a source file. No-op for
 *  findings without either marker. */
export function enrichFindingsWithVueSource(
  findings: Finding[],
  map: Map<string, string>,
  repoDir?: string,
): VueEnrichResult {
  let enriched = 0;
  let relativized = 0;
  const repoAbs = repoDir ? path.resolve(repoDir) : undefined;
  for (const f of findings) {
    const file = f.subject.file;
    if (file) {
      if (repoAbs && path.isAbsolute(file.path) && file.path.startsWith(repoAbs + path.sep)) {
        file.path = path.relative(repoAbs, file.path);
        relativized++;
      }
      continue;
    }
    const id = scopeIdOf(f);
    if (!id) continue;
    const mapped = map.get(id);
    if (!mapped) continue;
    f.subject.file = { path: mapped };
    enriched++;
  }
  return { components: new Set(map.values()).size, enriched, relativized };
}
