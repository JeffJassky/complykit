import http from 'node:http';

// A timing-race fixture (A7). The page loads a "consent tool" (cmp.test/cmp.js,
// padded so it is big) and arms a fail-open timer: if the tool has not reported
// ready in 1.5 s, the page loads its tracker anyway. On localhost the tool is
// instant and the tracker never fires; under Slow 3G the tool takes seconds
// and it does. One clean run says nothing about this site.

export interface RaceSite {
  port: number;
  url: string;
  launchArgs: string[];
  hits: string[];
  close(): Promise<void>;
}

const PAD = '/*' + 'x'.repeat(300 * 1024) + '*/';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Race shop</title>
<script>
  var cmpReady = false;
  window.__cmpReady = function(){ cmpReady = true; };
  // Fail-open: the consent tool is late, so the tracker loads without waiting for it.
  setTimeout(function(){ if (!cmpReady) { var s = document.createElement('script'); s.src = 'http://racetracker.test:PORT/t.js'; document.head.appendChild(s); } }, 1500);
</script>
<script src="http://cmp.test:PORT/cmp.js" async></script>
</head><body><h1>Welcome</h1><p>Nothing to see here.</p></body></html>`;

const ROUTES: Record<string, { type: string; body: string }> = {
  'shop/': { type: 'text/html', body: PAGE },
  'cmp.test/cmp.js': { type: 'application/javascript', body: `window.__cmpReady && window.__cmpReady();${PAD}` },
  'racetracker.test/t.js': { type: 'application/javascript', body: `new Image().src = 'http://racetracker.test:PORT/p?id=r4c3&u=' + encodeURIComponent(location.href);` },
};

export async function startRaceSite(): Promise<RaceSite> {
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
    res.writeHead(200, { 'content-type': route.type, 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
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
