import fs from 'node:fs';

// HAR export (plans/consent-design.md §2.5). A HAR is the standard exhibit —
// anyone can open it without complykit — but it is evidence, not the detection
// method (it has no initiator chains, no storage, and misses some background
// traffic; the timeline is what analysis runs on). Playwright records it per
// browser context. HARs carry cookies and tokens, so by default every cookie
// value, Cookie/Set-Cookie/Authorization header value and request body is
// replaced; `raw` keeps them.

const SECRET_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token']);
const MARK = '[redacted by complykit]';

interface HarHeader {
  name: string;
  value: string;
}
interface HarCookie {
  name: string;
  value: string;
}
interface HarEntry {
  request?: { headers?: HarHeader[]; cookies?: HarCookie[]; postData?: { text?: string; params?: Array<{ value?: string }> } };
  response?: { headers?: HarHeader[]; cookies?: HarCookie[]; content?: { text?: string } };
}

export function redactHar(har: { log?: { entries?: HarEntry[]; comment?: string } }): void {
  for (const e of har.log?.entries ?? []) {
    for (const side of [e.request, e.response]) {
      if (!side) continue;
      for (const h of side.headers ?? []) if (SECRET_HEADERS.has(h.name.toLowerCase())) h.value = MARK;
      for (const c of side.cookies ?? []) c.value = MARK;
    }
    if (e.request?.postData) {
      if (e.request.postData.text) e.request.postData.text = MARK;
      for (const p of e.request.postData.params ?? []) p.value = MARK;
    }
  }
  if (har.log) har.log.comment = 'Values redacted by complykit (cookies, auth headers, request bodies). Re-run with raw evidence to keep them.';
}

/** Redact a HAR file in place (no-op if it doesn't exist). */
export function redactHarFile(file: string): void {
  if (!fs.existsSync(file)) return;
  try {
    const har = JSON.parse(fs.readFileSync(file, 'utf8'));
    redactHar(har);
    fs.writeFileSync(file, JSON.stringify(har));
  } catch {
    // An unreadable HAR is deleted rather than shipped unredacted.
    fs.rmSync(file, { force: true });
  }
}
