// HTTP Basic auth with a single shared password (any username). Browsers
// prompt once and then resend the header on every request — including the
// EventSource stream and report pages — so the client needs no login UI.

import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

/** Paths that skip auth (Fly's health check can't send credentials). */
const OPEN_PATHS = new Set(['/api/health']);

function digest(s: string): Buffer {
  return crypto.createHash('sha256').update(s).digest();
}

export function basicAuth(password: string | undefined): RequestHandler {
  if (!password) return (_req, _res, next) => next();
  const expected = digest(password);
  return (req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    const header = req.get('authorization') ?? '';
    const m = /^Basic\s+(.+)$/i.exec(header);
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const given = sep >= 0 ? decoded.slice(sep + 1) : '';
      // Compare fixed-length digests so timing doesn't leak the length.
      if (crypto.timingSafeEqual(digest(given), expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="complykit", charset="UTF-8"');
    res.status(401).type('text/plain').send('Authentication required');
  };
}
