// The consent record (ticket D3): proof of one decision, sent to the owner's
// endpoint (`config.record.endpoint`, e.g. the complykit service's
// POST /api/consent-records) when one is configured.
//
// The body matches the service's allow-list exactly
// (service/src/server/consent-records.ts — an unknown field is a 400):
//   { id, at, kind, categories, configHash, toolVersion, regime, gpc, gpcHonored, supersedes?, region? }
// (`supersedes` and `region` are left out when there is none; JSON drops undefined.)
// `id` is a fresh random id PER DECISION (the service de-duplicates on it, so a
// per-visitor id would swallow a changed choice). Nothing else that could
// identify a visitor: no user agent, no URL, no referrer, no cookie values.
//
// Transport: fetch with a text/plain body (a CORS-simple request), keepalive so
// it survives page unload, credentials omitted. Delivery is confirmable: a
// record stays in a small localStorage outbox (5 records, 30 days) until the
// endpoint answers 2xx (or refuses it for good with a 4xx), and is resent on
// the next page. The server de-duplicates by id. A lost send never blocks or
// undoes the visitor's choice.

import type { StoredConsent } from './store.js';

export interface ConsentRecordBody {
  id: string;
  at: string;
  categories: Record<string, boolean>;
  configHash: string;
  toolVersion: string;
  regime: string;
  gpc?: boolean;
  gpcHonored?: boolean;
  kind?: 'choice' | 'withdrawal';
  supersedes?: string;
  region?: string;
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
  // The stored value minus its format number (JSON drops the undefined optionals).
  const { v, ...rest } = stored;
  return { ...rest, toolVersion };
}

// --- delivery: the outbox ---------------------------------------------------------

const BOX = 'complykit_consent_outbox';
const MAX_BOX = 5;
const MAX_AGE_MS = 30 * 86_400_000;

function readBox(): ConsentRecordBody[] {
  try {
    const a = JSON.parse(localStorage.getItem(BOX) || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
function writeBox(a: ConsentRecordBody[]): void {
  try {
    localStorage.setItem(BOX, JSON.stringify(a));
  } catch {
    /* blocked storage: the send still happens, just without a retry */
  }
}

function post(endpoint: string, b: ConsentRecordBody): void {
  try {
    fetch(endpoint, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'text/plain' }, keepalive: true, credentials: 'omit', mode: 'cors' }).then(
      (r) => {
        // Confirmed (2xx) or refused for good (4xx other than 408/429): done. Anything else stays for the next page.
        if (r.status < 500 && r.status !== 408 && r.status !== 429) writeBox(readBox().filter((x) => x.id !== b.id));
      },
      () => {},
    );
  } catch {
    /* no fetch: stays in the outbox */
  }
}

/** Keep the record in the outbox until the endpoint confirms it, and send it. */
export function queueRecord(endpoint: string, body: ConsentRecordBody): void {
  writeBox([...readBox(), body].slice(-MAX_BOX));
  post(endpoint, body);
}

/** On start: forget records older than 30 days, resend the rest. */
export function flushOutbox(endpoint: string, now: number): void {
  const all = readBox();
  const keep = all.filter((x) => now - Date.parse(x.at) < MAX_AGE_MS);
  if (keep.length !== all.length) writeBox(keep);
  for (const b of keep) post(endpoint, b);
}
