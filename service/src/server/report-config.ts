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
import { pipeline, Transform, type Readable, type TransformCallback } from 'node:stream';
import type { Request, RequestHandler, Response } from 'express';
import type { JobDetail, ReportServiceConfig } from '../shared/api.js';
import { siteDomain } from './domains.js';
import { isJobId, type JobStore } from './store.js';
import type { BlobInfo } from './storage/types.js';

export const SERVICE_CONFIG_ID = 'ck-service';
const WORKBENCH_MARKER = '<script type="application/json" id="workspace-config">';

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
 * Streams a report through, inserting the ck-service block just before the workbench marker (the first one).
 * Holds back only the last marker-length-minus-one bytes of each chunk, so a marker split across chunks is
 * found and nothing larger than a chunk is ever held: the report's size does not matter. Without a marker the
 * bytes come out unchanged.
 */
export function serviceConfigInjector(config: ReportServiceConfig): Transform {
  const marker = Buffer.from(WORKBENCH_MARKER);
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const block = Buffer.from(`<script type="application/json" id="${SERVICE_CONFIG_ID}">${json}</script>`);
  let found = false;
  let carry: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (found) {
        cb(null, chunk);
        return;
      }
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const at = buf.indexOf(marker);
      if (at >= 0) {
        found = true;
        carry = Buffer.alloc(0);
        this.push(buf.subarray(0, at));
        this.push(block);
        this.push(buf.subarray(at));
        cb();
        return;
      }
      const keep = Math.min(marker.length - 1, buf.length);
      this.push(buf.subarray(0, buf.length - keep));
      carry = Buffer.from(buf.subarray(buf.length - keep)); // copy: the chunk may be reused by its source
      cb();
    },
    flush(cb: TransformCallback) {
      if (carry.length) this.push(carry);
      cb();
    },
  });
}

/**
 * Handler for /reports/:id/…: the job's files, read through JobFiles (blobs for a
 * finished job, scratch for a running one). A .html report is streamed through
 * serviceConfigInjector, so a workbench one gets the config and any other is
 * unchanged; everything else is streamed as it is, with a content type from its
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
      const config = /\.html?$/i.test(rel) ? reportServiceConfig(job) : undefined;
      const stream = await files.read(job, rel);
      if (!stream) {
        res.status(404).type('text/plain').send('not found');
        return;
      }
      if (config) {
        // The body may or may not change (only a workbench gets the block), so its length is not known up front;
        // validators are the stored object's, marked as ours so the injected form and the raw one never share one.
        sendBytes(req, res, { ...info, etag: `${info.etag}-ck1` }, rel, pipeline(stream, serviceConfigInjector(config), () => undefined), false); // pipeline: destroying the output also closes the source
        return;
      }
      sendBytes(req, res, info, rel, stream);
    } catch (err) {
      next(err);
    }
  };
}

function sendBytes(req: Request, res: Response, info: BlobInfo, rel: string, body: Buffer | Readable, knownLength = true): void {
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
    if (knownLength) res.set('Content-Length', String(info.size));
    res.end();
    return;
  }
  if (knownLength) res.set('Content-Length', String(info.size));
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
}
