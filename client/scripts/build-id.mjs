// BUILD_ID: first 12 hex chars of sha256 over every file under client/src (sorted by path, path + content).
// Deterministic; changes whenever the client changes. Used by tsup.config.ts (define __CK_BUILD__) and
// written to dist/complykit-build.json (scripts/write-build.mjs) for the service.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

export function buildId() {
  const h = crypto.createHash('sha256');
  for (const f of walk(SRC).sort()) {
    h.update(path.relative(SRC, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}
