import fs from 'node:fs';
import path from 'node:path';
import { tracking } from './rules/index.js';
import { newLocalCopyStats, type LocalCopy, type LocalCopyReplacement, type LocalCopyResource } from './collect/browser/evaluation/local-copy.js';

// Local-copy spec (ticket D11; the collector half is
// collect/browser/evaluation/local-copy.ts). A JSON file the owner's change
// set is written into, applied by `complykit consent --local-copy <file>`
// inside the scanner's own browser — a TEST MODE for proving a change set
// before it is deployed, never a way to change the site:
//
//   {
//     "origin": "https://example-shop.test",         optional; default: the scanned URL's origin
//     "head": "snippet-head.html",                   file inserted first in <head> (the generated snippet, Part 1)
//     "replace": [                                   on every document from the origin
//       { "label": "gtag loader", "from": "<script …>", "to": "<script type=\"text/plain\" …>" },
//       { "label": "GTM noscript", "pattern": "<noscript>\\s*<iframe[^>]*ns\\.html[^]*?</noscript>", "flags": "g", "to": "" }
//     ],
//     "serve": { "/complykit/v1/complykit-consent.js": "../client/dist/complykit-consent.js" },
//     "containers": [                                simulated GTM settings ("Require additional consent for tag to fire")
//       { "url": "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX01",
//         "tags": { "110": ["analytics_storage"] }, "templates": { "__gaawe": ["analytics_storage"] } }
//     ]
//   }
//
// Paths are relative to the spec file. Every file must exist and the spec must
// change something, or loading fails — a local copy that silently applies
// nothing would be read as "the tool did nothing".

export interface LocalCopySpec {
  origin?: string;
  head?: string;
  replace?: Array<{ label?: string; from?: string; pattern?: string; flags?: string; to: string }>;
  serve?: Record<string, string>;
  containers?: Array<{ url: string; tags?: Record<string, string[]>; templates?: Record<string, string[]> }>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validate a spec object. Throws with the offending key. */
export function parseLocalCopySpec(raw: unknown): LocalCopySpec {
  if (!isObj(raw)) throw new Error('not a local-copy spec: expected an object');
  const out: LocalCopySpec = {};
  if (raw.origin !== undefined) {
    if (typeof raw.origin !== 'string') throw new Error('local-copy spec: origin must be a string');
    out.origin = raw.origin;
  }
  if (raw.head !== undefined) {
    if (typeof raw.head !== 'string' || !raw.head) throw new Error('local-copy spec: head must be a file path');
    out.head = raw.head;
  }
  if (raw.replace !== undefined) {
    if (!Array.isArray(raw.replace)) throw new Error('local-copy spec: replace must be a list');
    out.replace = raw.replace.map((r, i) => {
      if (!isObj(r) || typeof r.to !== 'string') throw new Error(`local-copy spec: replace[${i}] needs a string "to"`);
      if ((typeof r.from === 'string') === (typeof r.pattern === 'string')) throw new Error(`local-copy spec: replace[${i}] needs exactly one of "from" or "pattern"`);
      if (typeof r.from === 'string' && !r.from) throw new Error(`local-copy spec: replace[${i}].from is empty`);
      if (typeof r.pattern === 'string') {
        try {
          new RegExp(r.pattern, typeof r.flags === 'string' ? r.flags : '');
        } catch (err) {
          throw new Error(`local-copy spec: replace[${i}].pattern: ${err instanceof Error ? err.message : 'invalid'}`);
        }
      }
      return {
        label: typeof r.label === 'string' && r.label ? r.label : `replace[${i}]`,
        ...(typeof r.from === 'string' ? { from: r.from } : {}),
        ...(typeof r.pattern === 'string' ? { pattern: r.pattern, ...(typeof r.flags === 'string' ? { flags: r.flags } : {}) } : {}),
        to: r.to,
      };
    });
  }
  if (raw.serve !== undefined) {
    if (!isObj(raw.serve)) throw new Error('local-copy spec: serve must map a path to a file');
    out.serve = {};
    for (const [p, f] of Object.entries(raw.serve)) {
      if (!p.startsWith('/') || typeof f !== 'string' || !f) throw new Error(`local-copy spec: serve["${p}"] must map an absolute path to a file`);
      out.serve[p] = f;
    }
  }
  if (raw.containers !== undefined) {
    if (!Array.isArray(raw.containers)) throw new Error('local-copy spec: containers must be a list');
    out.containers = raw.containers.map((c, i) => {
      if (!isObj(c) || typeof c.url !== 'string') throw new Error(`local-copy spec: containers[${i}] needs a url`);
      try {
        new URL(c.url);
      } catch {
        throw new Error(`local-copy spec: containers[${i}].url is not a URL`);
      }
      const lists = (v: unknown, key: string): Record<string, string[]> | undefined => {
        if (v === undefined) return undefined;
        if (!isObj(v) || !Object.values(v).every(isStringList)) throw new Error(`local-copy spec: containers[${i}].${key} must map ids to lists of consent types`);
        return v as Record<string, string[]>;
      };
      const tags = lists(c.tags, 'tags');
      const templates = lists(c.templates, 'templates');
      if (!tags && !templates) throw new Error(`local-copy spec: containers[${i}] needs tags or templates`);
      return { url: c.url, ...(tags ? { tags } : {}), ...(templates ? { templates } : {}) };
    });
  }
  if (!out.head && !out.replace?.length && !Object.keys(out.serve ?? {}).length && !out.containers?.length) throw new Error('local-copy spec: nothing to apply (head, replace, serve or containers)');
  return out;
}

/** Read a spec file and resolve it against the scanned URL. Throws on any missing file. */
export function loadLocalCopy(file: string, targetUrl: string, cwd = process.cwd()): LocalCopy {
  const abs = path.resolve(cwd, file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`could not read local-copy spec ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const spec = parseLocalCopySpec(raw);
  const base = path.dirname(abs);
  const origin = spec.origin ? new URL(spec.origin).origin : new URL(targetUrl).origin;
  const read = (rel: string, what: string): string => {
    const p = path.resolve(base, rel);
    if (!fs.existsSync(p)) throw new Error(`local-copy spec: ${what} file not found: ${p}`);
    return p;
  };
  const head = spec.head ? fs.readFileSync(read(spec.head, 'head'), 'utf8').trim() : undefined;
  const replace: LocalCopyReplacement[] = (spec.replace ?? []).map((r) => ({
    label: r.label ?? 'replace',
    ...(r.from !== undefined ? { from: r.from } : {}),
    ...(r.pattern !== undefined ? { pattern: { source: r.pattern, ...(r.flags ? { flags: r.flags } : {}) } } : {}),
    to: r.to,
  }));
  const serve: LocalCopy['serve'] = {};
  for (const [p, f] of Object.entries(spec.serve ?? {})) {
    const abs = read(f, `serve["${p}"]`);
    serve[p] = { file: abs, contentType: CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' };
  }
  const resources: LocalCopyResource[] = (spec.containers ?? []).map((c) => ({
    url: c.url,
    transform(source) {
      const r = tracking.rewriteContainerConsent(source, { tags: c.tags, templates: c.templates });
      const parts = [
        r.rewritten.length ? `required consent on ${r.rewritten.length} tag(s): ${r.rewritten.slice(0, 12).join(', ')}${r.rewritten.length > 12 ? ', …' : ''}` : '',
        r.unchanged.length ? `${r.unchanged.length} already required it` : '',
        r.skipped.length ? `${r.skipped.length} skipped (unreadable consent setting): ${r.skipped.join(', ')}` : '',
        r.missing.length ? `not in the container: ${r.missing.join(', ')}` : '',
        r.reason ?? '',
      ].filter(Boolean);
      return { source: r.source, note: parts.join('; ') };
    },
  }));
  const lc: LocalCopy = { file, origin, head, replace, serve, resources, stats: newLocalCopyStats({ replace, serve, resources }) };
  return lc;
}
