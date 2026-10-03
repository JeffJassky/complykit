import http from 'node:http';

// A multi-host storefront fixture for the consent evaluation (M6 "done when").
// Chromium maps every *.test host to 127.0.0.1 (--host-resolver-rules), so one
// server plays the store and all of its third parties. The store itself is
// served on `localhost` — a secure context, so its service worker registers.
//
// What it does, on purpose:
//   - an HttpOnly first-party session cookie (Set-Cookie)
//   - a markup <img> ad pixel (adpixel.test) — leaks even with script gating
//   - a "tag manager" (cdn.tagmgr.test) that injects an UNKNOWN widget
//     (px.widget.test), which stores a 400-day ID and sends it + the page
//     address on every page — behaves like a tracker, fires before any choice
//   - a cross-site iframe (frame.test) that fetches px.frame.test
//   - a sandboxed srcdoc iframe that fetches px.srcdoc.test
//   - a dedicated worker fetching px.worker.test, a service worker fetching
//     px.sw.test on install
//   - a pagehide beacon to px.beacon.test (exit beacon)
//   - a keystroke-capturing "newsletter" script that sends the email field's
//     contents to px.capture.test as you type (never submitted)
//   - a cookie banner: Accept loads cdn.consented.test (gated); Reject doesn't
//   - GPC: when navigator.globalPrivacyControl is on, the ad pixel is skipped
//   - a footer "Do Not Sell or Share" link to a privacy-choices page with an
//     opt-out button that confirms "Opt-out request honored"

export interface TrackingSite {
  port: number;
  url: string;
  launchArgs: string[];
  hits: string[];
  close(): Promise<void>;
}

const page = (body: string, title: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<script src="http://cdn.tagmgr.test:PORT/tm.js" async></script>
</head><body>
<header><a href="/">Home</a> <a href="/collections/all">Shop</a> <a href="/cart">Cart</a>
<form role="search" action="/search"><input type="search" name="q" placeholder="Search"></form></header>
<main>${body}</main>
<img id="adpx" alt="" width="1" height="1" src="" data-src="http://adpixel.test:PORT/tr?ev=PageView&id=777&dl=">
<script>
  // Markup-style pixel: written by the page itself unless GPC is on.
  (function(){ var i=document.getElementById('adpx'); if(!navigator.globalPrivacyControl){ i.setAttribute('src', i.getAttribute('data-src') + encodeURIComponent(location.href)); } })();
</script>
<iframe src="http://frame.test:PORT/f" width="10" height="10"></iframe>
<iframe sandbox="allow-scripts" srcdoc="<script>fetch('http://px.srcdoc.test:PORT/x?u=1').catch(function(){})</script>" width="10" height="10"></iframe>
<section><label>Newsletter <input type="email" name="email" placeholder="Your email"></label></section>
<footer><a href="/privacy-choices">Do Not Sell or Share My Personal Information</a></footer>
<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:16px;border-top:1px solid #000;display:none">
  We use cookies to improve your experience.
  <button id="accept">Accept all</button> <button id="reject">Reject all</button>
</div>
<script>
  var consent = (document.cookie.match(/(?:^|; )consent=([^;]+)/)||[])[1];
  var banner = document.getElementById('cookie-banner');
  if (!consent) banner.style.display = 'block';
  if (consent === 'accept') { var s=document.createElement('script'); s.src='http://cdn.consented.test:PORT/c.js'; document.head.appendChild(s); }
  document.getElementById('accept').onclick = function(){ document.cookie='consent=accept; max-age=31536000; path=/'; banner.style.display='none'; var s=document.createElement('script'); s.src='http://cdn.consented.test:PORT/c.js'; document.head.appendChild(s); };
  document.getElementById('reject').onclick = function(){ document.cookie='consent=reject; max-age=31536000; path=/'; banner.style.display='none'; };
  new Worker('/worker.js');
  if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').catch(function(){});
  addEventListener('pagehide', function(){ navigator.sendBeacon('http://px.beacon.test:PORT/b?u=' + encodeURIComponent(location.href), 'bye'); });
  // Keystroke capture: sends the field contents as you type (no submit).
  document.querySelector('input[type=email]').addEventListener('input', function(e){ new Image().src = 'http://px.capture.test:PORT/k?v=' + encodeURIComponent(e.target.value); });
</script>
</body></html>`;

const ROUTES: Record<string, { type: string; body: string; headers?: Record<string, string> }> = {
  'shop/': { type: 'text/html', body: page('<h1>Welcome</h1><a href="/products/thing">A thing</a>', 'Home'), headers: { 'set-cookie': 'sid=s3ss10n; Path=/; HttpOnly' } },
  'shop/collections/all': { type: 'text/html', body: page('<h1>All products</h1><a href="/products/thing">A thing</a>', 'All') },
  'shop/products/thing': { type: 'text/html', body: page('<h1>A thing</h1>', 'A thing') },
  'shop/cart': { type: 'text/html', body: page('<h1>Cart</h1>', 'Cart') },
  'shop/privacy-choices': {
    type: 'text/html',
    body: `<!doctype html><title>Privacy choices</title><h1>Your privacy choices</h1>
<p id="status">You can opt out of the sale or sharing of your personal information.</p>
<button id="optout" onclick="document.cookie='dns=1; max-age=31536000; path=/'; document.getElementById('status').textContent='Opt-out request honored.'">Opt out of sale/sharing</button>`,
  },
  'shop/worker.js': { type: 'application/javascript', body: `fetch('http://px.worker.test:PORT/w').catch(function(){})` },
  'shop/sw.js': { type: 'application/javascript', body: `self.addEventListener('install', function(e){ e.waitUntil(fetch('http://px.sw.test:PORT/s').catch(function(){})); });` },
  'cdn.tagmgr.test/tm.js': {
    type: 'application/javascript',
    body: `(function(){ var s=document.createElement('script'); s.src='http://px.widget.test:PORT/w.js'; document.head.appendChild(s); })();`,
  },
  'px.widget.test/w.js': {
    type: 'application/javascript',
    body: `(function(){
  var m = document.cookie.match(/(?:^|; )_uw=([^;]+)/); var id = m ? m[1] : (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  document.cookie = '_uw=' + id + '; max-age=' + (400*86400) + '; path=/';
  try { localStorage.setItem('uw_id', id); } catch (e) {}
  new Image().src = 'http://px.widget.test:PORT/p?id=' + id + '&u=' + encodeURIComponent(location.href);
})();`,
  },
  'cdn.consented.test/c.js': { type: 'application/javascript', body: `new Image().src='http://px.consented.test:PORT/c?u='+encodeURIComponent(location.href);` },
  // Fake geolocation services (the proxy test routes lookups through a proxy to these).
  'geo-a.test/json': { type: 'application/json', body: '{"ip":"203.0.113.9","country":"DE","region":"BE"}' },
  'geo-b.test/json': { type: 'application/json', body: '{"ip":"203.0.113.9","country":"DE","region":"BE"}' },
  'frame.test/f': { type: 'text/html', body: `<script>fetch('http://px.frame.test:PORT/fr', {mode:'no-cors'}).catch(function(){})</script>` },
};

/** A minimal HTTP forward proxy that sends everything to the fixture server and
 *  records what passed through it. */
export async function startProxy(targetPort: number): Promise<{ url: string; seen: string[]; close(): Promise<void> }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    let u: URL;
    try {
      u = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const up = http.request(
      { host: '127.0.0.1', port: targetPort, method: req.method, path: u.pathname + u.search, headers: { ...req.headers, host: u.host } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function startTrackingSite(): Promise<TrackingSite> {
  const hits: string[] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    const hostHeader = (req.headers.host ?? '').split(':')[0];
    const host = hostHeader === 'localhost' ? 'shop' : hostHeader;
    const pathOnly = (req.url ?? '/').split('?')[0];
    hits.push(`${hostHeader}${req.url}`);
    const route = ROUTES[`${host}${pathOnly}`];
    if (!route) {
      res.writeHead(host === 'shop' ? 404 : 204, { 'access-control-allow-origin': '*' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': route.type, 'access-control-allow-origin': '*', ...(route.headers ?? {}) });
    res.end(route.body.replaceAll('PORT', String(port)));
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://localhost:${port}/`,
    launchArgs: ['--host-resolver-rules=MAP *.test 127.0.0.1'],
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
