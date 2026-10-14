// Served reports learn they are on the service. complykit's HTML reports are
// static files; when the service serves one, it injects a small JSON block
// (<script type="application/json" id="ck-service">) naming the site's
// workspace, and the report's workbench script saves classifications and task
// progress there instead of only in the viewer's browser (design §10). The
// same file opened from disk or an export has no block and keeps working
// offline against localStorage.
//
// Only reports that carry a workbench (the `workspace-config` block complykit
// emits) are touched; every other file is served as-is. Files come from
// JobFiles (job-files.ts), so this works the same whether the job's files are
// on the local disk or in blobs.

import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Request, RequestHandler, Response } from 'express';
import type { JobDetail, ReportServiceConfig } from '../shared/api.js';
import { siteDomain } from './domains.js';
import { isJobId, type JobStore } from './store.js';
import type { BlobInfo } from './storage/types.js';

export const SERVICE_CONFIG_ID = 'ck-service';
const WORKBENCH_MARKER = '<script type="application/json" id="workspace-config">';
const MAX_HTML_BYTES = 64 * 1024 * 1024;

/** The config for a job's reports, or undefined when its URL names no site. */
export function reportServiceConfig(job: Pick<JobDetail, 'id' | 'url'>): ReportServiceConfig | undefined {
  let host: string;
  try {
    host = new URL(job.url).hostname;
  } catch {
    return undefined;
  }
  const domain = siteDomain(host);
  if (!domain) return undefined;
  return { version: 1, domain, workspace: `/api/sites/${encodeURIComponent(domain)}/workspace`, jobId: job.id };
}

/** Insert the config just before the workbench's own config; html without a workbench is returned unchanged. */
export function injectServiceConfig(html: string, config: ReportServiceConfig): string {
  const at = html.indexOf(WORKBENCH_MARKER);
  if (at < 0) return html;
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `${html.slice(0, at)}<script type="application/json" id="${SERVICE_CONFIG_ID}">${json}</script>${html.slice(at)}`;
}

/**
 * Handler for /reports/:id/…: the job's files, read through JobFiles (blobs for a
 * finished job, scratch for a running one). A workbench .html gets the config
 * injected; everything else is streamed as it is, with a content type from its
 * extension (dotfile paths such as .comply/ are allowed). The path is decoded
 * and refused if it could leave the job: that is a 403 for `..`, a 404 for
 * anything else that is not a file.
 */
export function serveReports(store: JobStore): RequestHandler {
  return async (req, res, next) => {
    try {
      const id = String(req.params.id ?? '');
      const job = isJobId(id) ? store.get(id) : undefined;
      if (!job) {
        res.status(404).type('text/plain').send('report not found');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.set('Allow', 'GET, HEAD').status(405).type('text/plain').send('method not allowed');
        return;
      }
      let rel: string;
      try {
        rel = decodeURIComponent(req.path);
      } catch {
        res.status(400).type('text/plain').send('bad request');
        return;
      }
      if (rel.includes('\0') || rel.includes('\\')) {
        res.status(400).type('text/plain').send('bad request');
        return;
      }
      const segs = rel.replace(/^\//, '').split('/');
      if (segs.includes('..')) {
        res.status(403).type('text/plain').send('forbidden');
        return;
      }
      rel = segs.join('/');
      // A trailing slash, an empty or '.' segment, or the job's record: not a report file.
      if (!rel || segs.some((x) => x === '' || x === '.') || rel === 'job.json' || /[\u0000-\u001f\u007f]/.test(rel)) {
        res.status(404).type('text/plain').send('not found');
        return;
      }

      const files = store.files;
      const info = await files.head(job, rel).catch((err: Error) => (/not a usable blob key/.test(err.message) ? null : Promise.reject(err)));
      if (!info) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      const isHtml = /\.html?$/i.test(rel);
      const config = isHtml && info.size <= MAX_HTML_BYTES ? reportServiceConfig(job) : undefined;
      if (config) {
        const buf = await files.get(job, rel);
        if (!buf) {
          res.status(404).type('text/plain').send('not found');
          return;
        }
        const html = buf.toString('utf8');
        if (html.includes(WORKBENCH_MARKER)) {
          // The injected block changes per service, so the stored file's validators don't describe this response.
          res.set('Cache-Control', 'no-store');
          res.type('html').send(injectServiceConfig(html, config));
          return;
        }
        // No workbench: the bytes as they are.
        sendBytes(req, res, info, rel, buf);
        return;
      }
      const stream = await files.read(job, rel);
      if (!stream) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      sendBytes(req, res, info, rel, stream);
    } catch (err) {
      next(err);
    }
  };
}

function sendBytes(req: Request, res: Response, info: BlobInfo, rel: string, body: Buffer | Readable): void {
  res.type(path.extname(rel) || 'bin');
  res.set('ETag', `"${info.etag}"`);
  res.set('Last-Modified', new Date(info.modified).toUTCString());
  res.set('Cache-Control', 'public, max-age=0');
  if (req.fresh) {
    if (!Buffer.isBuffer(body)) body.destroy();
    res.status(304).end();
    return;
  }
  if (Buffer.isBuffer(body)) {
    res.send(body);
    return;
  }
  if (req.method === 'HEAD') {
    body.destroy();
    res.set('Content-Length', String(info.size)).end();
    return;
  }
  res.set('Content-Length', String(info.size));
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
}
