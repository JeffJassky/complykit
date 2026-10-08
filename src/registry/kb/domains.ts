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

// Shared cloud storage and compute hosts whose suffix has more labels than the
// set above handles, or varies by region: the label to the left of the suffix
// is a separate owner's bucket or app (storyfolder-releases.s3.amazonaws.com is
// one site's bucket, not "Amazon").
const PLATFORM_PATTERNS: Array<{ re: RegExp; provider: string }> = [
  { re: /(?:^|\.)(s3(?:[.-](?:dualstack|website|accelerate|external-\d|[a-z]{2}(?:-gov)?-[a-z]+-\d))*\.amazonaws\.com(?:\.cn)?)$/, provider: 'Amazon S3' },
  { re: /(?:^|\.)(execute-api\.[a-z0-9-]+\.amazonaws\.com)$/, provider: 'AWS API Gateway' },
  { re: /(?:^|\.)(lambda-url\.[a-z0-9-]+\.on\.aws)$/, provider: 'AWS Lambda' },
  { re: /(?:^|\.)(storage\.googleapis\.com)$/, provider: 'Google Cloud Storage' },
  { re: /(?:^|\.)(blob\.core\.windows\.net)$/, provider: 'Azure Blob Storage' },
  { re: /(?:^|\.)([a-z0-9-]+\.(?:cdn\.)?digitaloceanspaces\.com)$/, provider: 'DigitalOcean Spaces' },
  { re: /(?:^|\.)(r2\.dev)$/, provider: 'Cloudflare R2' },
  { re: /(?:^|\.)(azureedge\.net)$/, provider: 'Azure CDN' },
  { re: /(?:^|\.)(b-cdn\.net)$/, provider: 'Bunny CDN' },
];

// The hosting platforms above, by name, for labels.
const PLATFORM_NAMES: Record<string, string> = {
  'myshopify.com': 'Shopify', 'shopifypreview.com': 'Shopify', 'github.io': 'GitHub Pages', 'netlify.app': 'Netlify',
  'vercel.app': 'Vercel', 'pages.dev': 'Cloudflare Pages', 'workers.dev': 'Cloudflare Workers', 'herokuapp.com': 'Heroku',
  'azurewebsites.net': 'Azure App Service', 'cloudfront.net': 'Amazon CloudFront', 'appspot.com': 'Google App Engine',
  'firebaseapp.com': 'Firebase', 'web.app': 'Firebase', 'wixsite.com': 'Wix', 'squarespace.com': 'Squarespace',
  'webflow.io': 'Webflow', 'blogspot.com': 'Blogger', 'wordpress.com': 'WordPress.com', 'onrender.com': 'Render',
  'fly.dev': 'Fly.io', 'amplifyapp.com': 'AWS Amplify',
};

function platformSuffix(h: string): { suffix: string; provider: string } | undefined {
  for (const p of PLATFORM_PATTERNS) {
    const m = p.re.exec(h);
    if (m) return { suffix: m[1], provider: p.provider };
  }
  return undefined;
}

/**
 * A domain on a shared cloud or hosting platform: who hosts it and the
 * tenant's name ('storyfolder-releases.s3.amazonaws.com' → Amazon S3,
 * 'storyfolder-releases'). Undefined for an ordinary domain.
 */
export function hostedOn(domain: string): { provider: string; name: string } | undefined {
  const h = domain.toLowerCase();
  const p = platformSuffix(h);
  if (p) return h === p.suffix ? undefined : { provider: p.provider, name: h.slice(0, -(p.suffix.length + 1)) };
  const labels = h.split('.');
  if (labels.length < 3) return undefined;
  for (const take of [2, 3]) {
    const name = PLATFORM_NAMES[labels.slice(-take).join('.')];
    if (name && labels.length === take + 1) return { provider: name, name: labels[0] };
  }
  return undefined;
}

/** A party's display name from its domain: 'storyfolder-releases (Amazon S3)' for a cloud tenant, else the domain. */
export function domainLabel(domain: string): string {
  const on = hostedOn(domain);
  return on ? `${on.name} (${on.provider})` : domain;
}

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
  const platform = platformSuffix(h);
  if (platform) {
    if (h === platform.suffix) return h;
    const rest = h.slice(0, -(platform.suffix.length + 1)).split('.');
    return `${rest[rest.length - 1]}.${platform.suffix}`;
  }
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
