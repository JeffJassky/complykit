// Registrable domain ("eTLD+1") for site workspaces. The service never imports
// complykit (every complykit call is a CLI child process), so this is a copy of
// complykit's src/registry/kb/domains.ts registrableDomain — the same suffix
// list, so a workspace is keyed exactly the way a scan groups first-party hosts.
// test/workspace.test.ts fails if the two drift apart.

const MULTI_LABEL_SUFFIXES = new Set([
  // country second levels
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.br', 'net.br', 'org.br',
  'com.mx', 'com.ar', 'com.co', 'com.tr', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'net.cn', 'org.cn',
  'co.in', 'net.in', 'org.in', 'co.za', 'co.kr', 'or.kr', 'co.il', 'com.my', 'com.ph', 'com.vn',
  'co.id', 'com.pk', 'com.eg', 'com.sa', 'com.ua', 'co.th',
  // hosting platforms: each subdomain is a separate site/owner
  'myshopify.com', 'shopifypreview.com', 'github.io', 'netlify.app', 'vercel.app', 'pages.dev',
  'workers.dev', 'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com',
  'firebaseapp.com', 'web.app', 'wixsite.com', 'squarespace.com', 'webflow.io', 'blogspot.com',
  'wordpress.com', 'myshopify.io', 'onrender.com', 'fly.dev', 'amplifyapp.com',
]);

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** 'px.ads.linkedin.com' → 'linkedin.com'; 'shop.example.co.uk' → 'example.co.uk'. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || isIp(h) || !h.includes('.')) return h;
  const labels = h.split('.');
  for (let take = 3; take >= 2; take--) {
    if (labels.length > take) {
      const suffix = labels.slice(-take).join('.');
      if (MULTI_LABEL_SUFFIXES.has(suffix)) return labels.slice(-(take + 1)).join('.');
    }
  }
  if (labels.length >= 2 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join('.'))) return h;
  return labels.slice(-2).join('.');
}

const LABEL = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
const HOST_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

/**
 * The workspace key for whatever names a site — a host, a host with a port, an
 * IDN — or undefined when it isn't a domain. Only hostname characters get
 * through: no '/', '\\', '%', '@' or empty labels, so the result is always a
 * single safe path segment.
 */
export function siteDomain(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim();
  if (!t || t.length > 253 || /[^\w.:\-\u0080-￿]/.test(t)) return undefined;
  let host: string;
  try {
    host = new URL(`http://${t}`).hostname;
  } catch {
    return undefined;
  }
  host = host.toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(host)) return undefined; // also rejects [ipv6]
  const domain = registrableDomain(host);
  // 'co.uk' or 'myshopify.com' alone names no one site.
  if (MULTI_LABEL_SUFFIXES.has(domain)) return undefined;
  return HOST_RE.test(domain) ? domain : undefined;
}
