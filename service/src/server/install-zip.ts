// GET /api/sites/:domain/install.zip (remediation flow R5): everything the
// site owner's developer uploads and pastes, in one download.
//
//   complykit/v1/complykit-consent.js        } the folder of the snippet's script src,
//   complykit/v1/complykit-consent-ui.js     } so unzipping at the web root lines up
//   snippet.html
//   change-list.md
//   INSTALL.txt
//
// The two client files come from the built client (COMPLYKIT_CLIENT_DIST); the
// rest from the site workspace's stored config (`config.value`).

import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import type { Response } from 'express';
import type { ConsentConfigValue } from '../shared/api.js';
import { WorkspaceError } from './workspace.js';

export const CLIENT_FILES = ['complykit-consent.js', 'complykit-consent-ui.js'] as const;
const DEFAULT_SRC = '/complykit/v1/complykit-consent.js';

/** The script src the snippet loads (value.scriptSrc, else read from the snippet itself). */
export function scriptSrcOf(v: Partial<ConsentConfigValue>): string {
  if (typeof v.scriptSrc === 'string' && v.scriptSrc) return v.scriptSrc;
  const cfg = v.config as { scriptSrc?: unknown } | undefined;
  if (typeof cfg?.scriptSrc === 'string' && cfg.scriptSrc) return cfg.scriptSrc;
  const m = v.snippet ? /<script src="([^"]+)"><\/script>/.exec(v.snippet) : null;
  return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&') : DEFAULT_SRC;
}

/** '/assets/ck/complykit-consent.js?v=1' → { folder: 'assets/ck', file: 'complykit-consent.js' } (zip-safe: no `..`, no leading slash). */
export function installPlacement(scriptSrc: string): { folder: string; file: string } {
  let p = scriptSrc;
  try {
    p = new URL(scriptSrc, 'https://x.invalid').pathname;
  } catch {
    /* use as given */
  }
  const parts = p.split('/').filter((x) => x && x !== '.' && x !== '..');
  const file = parts.pop() || CLIENT_FILES[0];
  return { folder: parts.join('/'), file };
}

export function installText(scriptSrc: string, domain: string): string {
  return `complykit consent tool: install files for ${domain}

1. Upload the complykit/ folder from this zip to your site so the two files are served
   at the same path as in snippet.html:
     ${scriptSrc}
   (complykit-consent-ui.js must sit in the same folder). Serve them from your own
   domain, not a third-party CDN: that would be a request before consent.

2. Paste snippet.html, part 1 (the two elements: the JSON config and the script tag), FIRST
   in <head>, right after <meta charset> and above Google Tag Manager and every other
   script. Keep the script blocking: no async, no defer, no type="module", and exclude
   it from any performance plugin that delays or combines JavaScript.

3. Remove any existing consent plugin or banner (its script, app or plugin), in the same
   deploy, so the site is never without one and never has two.

4. The rest of snippet.html and change-list.md list each tag to rewrite or change.

5. Deploy, then press Verify on the "Install the complykit consent tool" task in the
   complykit service. It fetches your page and checks that this config is the latest one
   and that the tool runs before any tag.
`;
}

export async function sendInstallZip(res: Response, domain: string, value: unknown, clientDist: string): Promise<void> {
  const v = value as Partial<ConsentConfigValue> | undefined;
  if (!v || typeof v.snippet !== 'string' || !v.snippet) throw new WorkspaceError(404, 'no consent config for this site yet: generate the config first');
  const missing = CLIENT_FILES.filter((f) => !fs.existsSync(path.join(clientDist, f)));
  if (missing.length) throw new WorkspaceError(503, `the consent client is not built on this server (missing ${missing.join(', ')} in ${clientDist}); build client/ or set COMPLYKIT_CLIENT_DIST`);

  const scriptSrc = scriptSrcOf(v);
  const { folder, file } = installPlacement(scriptSrc);
  const at = (name: string): string => (folder ? `${folder}/${name}` : name);

  res.status(200);
  res.set('Content-Type', 'application/zip');
  res.attachment(`complykit-install-${domain.replace(/[^a-z0-9.-]+/gi, '-')}.zip`);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.on('warning', (err: Error) => console.warn(`[install-zip] ${domain}: ${err.message}`));
  zip.on('error', (err: Error) => {
    console.error(`[install-zip] ${domain}: ${err.message}`);
    res.destroy(err);
  });
  res.on('close', () => {
    if (!res.writableFinished) zip.abort();
  });
  zip.pipe(res);
  zip.file(path.join(clientDist, CLIENT_FILES[0]), { name: at(file) });
  zip.file(path.join(clientDist, CLIENT_FILES[1]), { name: at(CLIENT_FILES[1]) });
  zip.append(v.snippet, { name: 'snippet.html' });
  zip.append(typeof v.changeList === 'string' ? v.changeList : '', { name: 'change-list.md' });
  zip.append(installText(scriptSrc, domain), { name: 'INSTALL.txt' });
  await zip.finalize();
}
