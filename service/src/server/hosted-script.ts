// The hosted consent script (plans/hosted-script.md "Hosted script", "UI file").
//
//   GET /s/<host>.js              the site's config + the core bundle, one file
//   GET /s/complykit-consent-ui.js the UI bundle (build-pinned URL: immutable)
//   GET /s/complykit-consent-companion.js the add-on mode bundle (same caching as the UI bundle)
//
// Public by design: a visitor's browser on a client's site requests it, mounted
// before basic auth. It never sets or reads a cookie (P1). The served config is
// the site's stored workspace config with this host's endpoints filled in and
// re-hashed, so it follows every config change at the same URL (B1).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import type { ConsentSettings } from '../shared/api.js';
import { configHash } from './config-hash.js';
import { applyConsentSettings, storedConsentSettings } from './consent-settings.js';
import { siteDomain } from './domains.js';
import type { ServiceConfig } from './config.js';
import type { ConfigSnapshotRecords } from './storage/types.js';
import type { WorkspaceStore } from './workspace.js';

export const CORE_FILE = 'complykit-consent.js';
export const UI_FILE = 'complykit-consent-ui.js';
/** The UI bundle's URL path segment: no TLD, so it can never be a site. */
export const UI_NAME = 'complykit-consent-ui';
export const COMPANION_FILE = 'complykit-consent-companion.js';
/** `{"build":"<12 hex>"}` written by the client build: the id the core puts in `?v=`. */
export const BUILD_FILE = 'complykit-build.json';
/** The add-on (companion) bundle's URL path segment; like UI_NAME it can never be a site. */
export const COMPANION_NAME = 'complykit-consent-companion';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The config a visitor's browser runs: the stored config with the record and
 * analytics endpoints pointing at this host, re-hashed (identical to the
 * package's hashConsentToolConfig). Deterministic. `settings` (the owner's
 * install form) is applied first, then the endpoints (add-on mode keeps no
 * `record`: the banner holds its own proof), then the hash.
 */
export function hostedConfig(stored: Record<string, unknown>, publicOrigin: string, settings?: ConsentSettings): Record<string, unknown> & { hash: string } {
  const out: Record<string, unknown> = {
    ...applyConsentSettings(stored, settings),
    analytics: { endpoint: `${publicOrigin}/e` },
    hash: '',
  };
  // A site on the generated meta source learns the location from this host (GET /geo); the client
  // still reads the meta tag first, so a site that writes one keeps it. platform, fixed and an
  // owner-chosen header source stay as they are.
  if (isObj(out.regimeSource) && out.regimeSource.kind === 'meta') out.regimeSource = { kind: 'header', header: 'complykit-geo', endpoint: `${publicOrigin}/geo` };
  if (settings?.mode === 'companion') delete out.record;
  else out.record = { endpoint: `${publicOrigin}/api/consent-records` };
  const hash = configHash(out);
  out.hash = hash;
  return out as Record<string, unknown> & { hash: string };
}

interface Bundle {
  /** Cheap change detector (mtime + size) so a render cache entry dies with a new build. */
  stamp: string;
  body: Buffer;
}

/** Reads a built client file, re-reading when it changes on disk. */
class BundleFile {
  private cached?: Bundle;
  constructor(private readonly file: string) {}

  read(): Bundle | undefined {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      this.cached = undefined;
      return undefined;
    }
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (this.cached?.stamp !== stamp) this.cached = { stamp, body: fs.readFileSync(this.file) };
    return this.cached;
  }
}

/** sha-256 over core + UI + companion bundle + build file + public origin: the boot purge compares it with the last one. */
export function hostedBundleHash(dist: string, publicOrigin: string): string {
  const h = crypto.createHash('sha256');
  for (const f of [CORE_FILE, UI_FILE, COMPANION_FILE, BUILD_FILE]) {
    try {
      h.update(fs.readFileSync(path.join(dist, f)));
    } catch {
      h.update('');
    }
    h.update('\0');
  }
  h.update(publicOrigin);
  return h.digest('hex');
}

interface Rendered {
  key: string;
  body: Buffer;
  etag: string;
  config: Record<string, unknown> & { hash: string };
}

export interface HostedScriptDeps {
  config: Pick<ServiceConfig, 'consentClientDist' | 'publicOrigin' | 'cdn' | 'version'>;
  workspaces: WorkspaceStore;
  snapshots: ConfigSnapshotRecords;
  log?: (message: string) => void;
}

export interface HostedScript {
  router: express.Router;
  /** Drop the domain's rendered copy (its config or settings changed). */
  invalidate(domain: string): void;
}

const HOST_RE = /^[a-z0-9.-]{1,253}$/;
const CACHE_SHORT = 'public, max-age=60';
const CACHE_CDN = 'public, max-age=60, s-maxage=3600, stale-while-revalidate=60, stale-if-error=604800';
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

export function hostedScript(deps: HostedScriptDeps): HostedScript {
  const { config, workspaces } = deps;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const core = new BundleFile(path.join(config.consentClientDist, CORE_FILE));
  const ui = new BundleFile(path.join(config.consentClientDist, UI_FILE));
  const companion = new BundleFile(path.join(config.consentClientDist, COMPANION_FILE));
  const buildFile = new BundleFile(path.join(config.consentClientDist, BUILD_FILE));
  /** The client build id, or undefined when the file is missing or unreadable. */
  const buildId = (): string | undefined => {
    try {
      const b = buildFile.read();
      if (!b) return undefined;
      const v: unknown = JSON.parse(b.body.toString('utf8'));
      return isObj(v) && typeof v.build === 'string' && v.build ? v.build : undefined;
    } catch {
      return undefined;
    }
  };
  const rendered = new Map<string, Rendered>();
  const snapshotted = new Set<string>();
  const cdn = Boolean(config.cdn);

  const common = (res: Response): void => {
    res.set({
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    });
  };

  const etagOf = (body: Buffer): string => `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;

  /** Send `body` (or 304 when the browser already has it). */
  const send = (req: Request, res: Response, body: Buffer, etag: string, cacheControl: string): void => {
    common(res);
    res.set({ 'Cache-Control': cacheControl, ETag: etag });
    const inm = req.get('if-none-match');
    if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}` || t.trim() === '*')) {
      res.status(304).end();
      return;
    }
    res.status(200).send(body);
  };

  const unavailable = (res: Response): void => {
    common(res);
    res.set('Cache-Control', 'no-store');
    res.status(503).send('/* complykit: the consent client is not built on this server */\n');
  };

  const router = express.Router();

  router.get('/s/:file', (req, res, next) => {
    void handle(req, res).catch(next);
  });

  async function handle(req: Request, res: Response): Promise<void> {
    const file = String(req.params.file ?? '');
    if (!file.endsWith('.js')) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    const name = file.slice(0, -3).toLowerCase();

    if (name === UI_NAME || name === COMPANION_NAME) {
      const bundle = (name === UI_NAME ? ui : companion).read();
      if (!bundle) return unavailable(res);
      const build = buildId();
      const pinned = build !== undefined && req.query.v === build;
      send(req, res, bundle.body, etagOf(bundle.body), pinned ? CACHE_IMMUTABLE : CACHE_SHORT);
      return;
    }

    if (!HOST_RE.test(name)) {
      common(res);
      res.set('Cache-Control', 'no-store');
      res.status(400).send('/* complykit: not a site domain */\n');
      return;
    }
    const domain = siteDomain(name);
    if (!domain) {
      common(res);
      res.set('Cache-Control', 'no-store');
      res.status(400).send('/* complykit: not a site domain */\n');
      return;
    }
    if (domain !== name) {
      res.set({ 'Cache-Control': CACHE_SHORT, Location: `/s/${domain}.js` });
      common(res);
      res.status(301).end();
      return;
    }

    const ws = await workspaces.get(domain);
    const stored = ws.config && isObj(ws.config.value) && isObj(ws.config.value.config) ? ws.config.value.config : undefined;
    if (!ws.config || !stored) {
      common(res);
      res.set('Cache-Control', CACHE_SHORT);
      res.status(404).send(`/* complykit: no consent config for ${domain} */\n`);
      return;
    }
    const bundle = core.read();
    if (!bundle) return unavailable(res);

    const settings = storedConsentSettings(ws);
    const key = `${ws.config.at}|${bundle.stamp}|${config.publicOrigin}|${settings ? JSON.stringify(settings) : ''}`;
    let hit = rendered.get(domain);
    if (!hit || hit.key !== key) {
      const served = hostedConfig(stored, config.publicOrigin, settings);
      const head = Buffer.from(`/*! complykit ${config.version} | ${domain} | config ${served.hash.slice(0, 12)} */\nwindow.ComplyKitConfig=${JSON.stringify(served)};\n`);
      const body = Buffer.concat([head, bundle.body]);
      hit = { key, body, etag: etagOf(body), config: served };
      rendered.set(domain, hit);
    }
    // The first time a hash is served its config is kept (retried on the next request if storage failed).
    if (!snapshotted.has(hit.config.hash)) {
      try {
        await deps.snapshots.put({ hash: hit.config.hash, domain, config: hit.config, firstServed: new Date().toISOString() });
        snapshotted.add(hit.config.hash);
      } catch (err) {
        log(`[hosted-script] could not store the config snapshot ${hit.config.hash.slice(0, 12)} for ${domain}: ${(err as Error).message}`);
      }
    }
    send(req, res, hit.body, hit.etag, cdn ? CACHE_CDN : CACHE_SHORT);
  }

  return {
    router,
    invalidate: (domain) => void rendered.delete(domain),
  };
}
