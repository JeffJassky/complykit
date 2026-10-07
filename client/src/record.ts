// The consent record (ticket D3): proof of one decision, sent to the owner's
// endpoint (`config.record.endpoint`, e.g. the complykit service's
// POST /api/consent-records) when one is configured.
//
// The body matches the service's allow-list exactly
// (service/src/server/consent-records.ts — an unknown field is a 400):
//   { id, at, categories, configHash, toolVersion, regime, gpc }
// `id` is a fresh random id PER DECISION (the service de-duplicates on it, so a
// per-visitor id would swallow a changed choice). Nothing else that could
// identify a visitor: no user agent, no URL, no referrer, no cookie values.
//
// Transport: navigator.sendBeacon with a text/plain body (a CORS-simple
// request that survives page unload), falling back to fetch keepalive with the
// same body. Credentials are omitted on the fetch path. Fire and forget: a lost
// record never blocks or undoes the visitor's choice.

import type { StoredConsent } from './store.js';

export interface ConsentRecordBody {
  id: string;
  at: string;
  categories: Record<string, boolean>;
  configHash: string;
  toolVersion: string;
  regime: string;
  gpc?: boolean;
}

/** 32 hex chars (128 bits) from the platform CSPRNG; matches the service's id pattern. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out;
}

export function buildRecord(stored: StoredConsent, toolVersion: string): ConsentRecordBody {
  return {
    id: stored.id,
    at: stored.at,
    categories: { ...stored.categories },
    configHash: stored.configHash,
    toolVersion,
    regime: stored.regime,
    gpc: stored.gpc,
  };
}

export function sendRecord(endpoint: string, body: ConsentRecordBody): void {
  const text = JSON.stringify(body);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      // A string body goes out as text/plain;charset=UTF-8 (CORS-simple). Not a
      // Blob: WebKit sends a Blob beacon fine, but request interception
      // (Playwright, our own scanner) cannot read its body there (F5).
      if (navigator.sendBeacon(endpoint, text)) return;
    }
  } catch {
    /* fall through to fetch */
  }
  if (typeof fetch !== 'function') return;
  fetch(endpoint, { method: 'POST', body: text, headers: { 'content-type': 'text/plain' }, keepalive: true, credentials: 'omit', mode: 'cors' }).catch(() => {});
}
