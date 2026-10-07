// Served reports learn they are on the service. complykit's HTML reports are
// static files; when the service serves one, it injects a small JSON block
// (<script type="application/json" id="ck-service">) naming the site's
// workspace, and the report's workbench script saves classifications and task
// progress there instead of only in the viewer's browser (design §10). The
// same file opened from disk or an export has no block and keeps working
// offline against localStorage.
//
// Only reports that carry a workbench (the `workspace-config` block complykit
// emits) are touched; every other file is served as-is.

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from 'express';
import type { JobDetail, ReportServiceConfig } from '../shared/api.js';
import { siteDomain } from './domains.js';

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
 * Middleware for /reports/:id: answers GET/HEAD for a workbench .html with the
 * config injected; everything else (and any HTML it can't read) falls through
 * to the static handler, which owns 404s and path-escape refusals.
 */
export function serveReportWithConfig(jobDir: string, job: JobDetail): RequestHandler {
  return async (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !/\.html?$/i.test(req.path)) return next();
    const config = reportServiceConfig(job);
    if (!config) return next();
    let rel: string;
    try {
      rel = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const root = path.resolve(jobDir);
    const file = path.resolve(root, '.' + rel);
    if (rel.includes('\0') || !file.startsWith(root + path.sep)) return next();
    let html: string;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_HTML_BYTES) return next();
      html = await fsp.readFile(file, 'utf8');
    } catch {
      return next();
    }
    if (!html.includes(WORKBENCH_MARKER)) return next();
    // The injected block changes per service, so the static file's caching
    // validators don't describe this response.
    res.set('Cache-Control', 'no-store');
    res.type('html').send(injectServiceConfig(html, config));
  };
}
