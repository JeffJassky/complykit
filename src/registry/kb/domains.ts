// Registrable domain ("eTLD+1") without a dependency. The full Public Suffix
// List is ~250 KB; party grouping only needs to avoid the two common errors —
// treating `co.uk` as a registrable domain, and splitting a vendor across its
// own subdomains — so this carries the multi-label public suffixes that real
// storefront and tracker traffic actually hits, plus hosting platforms whose
// subdomains are DIFFERENT owners (myshopify.com, github.io, …). An unlisted
// multi-label suffix degrades to "last two labels", which over-groups a little;
// it never invents a first party.

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

/** Lower-cased host without port or trailing dot. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

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

/** True if `host` is `suffix` or a subdomain of it. */
export function hostMatches(host: string, suffix: string): boolean {
  const h = host.toLowerCase();
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}
