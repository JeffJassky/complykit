# Visitor location and regime

The consent tool has to decide **before any tracker can run** whether a visitor needs
to opt in or may opt out. That decision depends on where the visitor is, and the
browser does not know where it is.

complykit never asks a third-party geolocation service from the browser. That call
would send the visitor's IP address to a third party before consent, which is exactly
what the scanner reports. The location has to come from **your own server, your CDN
or your platform**. This page covers how to provide it.

## How the regime is decided

The tool reads a location such as `DE` or `US-CA` (ISO 3166-1 country, with an optional
ISO 3166-2 subdivision) and passes it to `regimeFor()`. That function is shared with
the scanner, so both use the same table:

| Location | Regime | What it means |
|---|---|---|
| EU/EEA country, UK | `opt-in` | Nothing but `necessary` runs until the visitor grants it. |
| US state whose law requires honoring opt-out signals (CA, CO, CT, TX, MT, NE, NH, NJ, MN, MD, OR, DE), from the date that duty started | `opt-out-signal` | Tracking may run until the visitor opts out. Global Privacy Control counts as the opt-out. |
| Any other US state | `opt-out` | Tracking may run until the visitor opts out. GPC is still honored (below). |
| `US` with no state, or a state code we don't recognize | `opt-out-signal` | The strictest US regime, because the visitor may be in California. |
| Any other country, or no location at all | `opt-in` | Fail closed. Countries we have not researched get the strictest regime. |

The scanner (not the consent tool) also checks, in every state with a privacy act in
force on the scan date, that the site offers a clear and conspicuous way to opt out of
targeted advertising and sale (`us-states.opt-out-method`). That is why Virginia, Utah,
Iowa and the other states with an act but no signal duty still get the opt-out-link check.
The state list and each act's start date are in `src/registry/us-states.ts`.

## What the scanner compares against, per location

The scanner measures each verified location against the rules for that place on the scan
date. The report shows each location's model, with a popover that lists the laws. The
table below is generated from the registry for 2026-10-08.

| Location | Model | Laws compared |
|---|---|---|
| DE | Opt-in (EU/EEA) | ePrivacy Directive Art. 5(3), GDPR Art. 13(1)(e), GDPR Art. 4(11), GDPR Art. 7(3) |
| GB | Opt-in (UK) | Privacy and Electronic Communications (EC Directive) Regulations 2003 reg. 6, UK GDPR Art. 4(11), UK GDPR Art. 7(3) |
| US-CA | Opt-out, privacy signal honored (California) | 11 CCR §7013, 7015, 7026; 11 CCR §7004(a)(2); 11 CCR §7025(b)–(c); 11 CCR §7025(c)(6); Cal. Penal Code §631(a); Cal. Penal Code §638.51 |
| US-TX | Opt-out, privacy signal honored (Texas) | State comprehensive privacy acts right to opt out of targeted advertising and sale, and the clear and conspicuous disclosure of how (e.g. Va. Code §59.1-578(D)); State comprehensive privacy acts universal opt-out mechanism provisions (e.g. Colo. Rev. Stat. §6-1-1306(1)(a)(IV)) |
| US-VA | Opt-out (Virginia) | State comprehensive privacy acts right to opt out of targeted advertising and sale, and the clear and conspicuous disclosure of how (e.g. Va. Code §59.1-578(D)) |
| US-FL | Opt-out (Florida, no state privacy law in force) | Fla. Stat. §934.03 |
| US-NY | Opt-out (New York, no state privacy law in force) | none |
| US (no state) | Opt-out (US, state not verified) | none |
| BR | No rules encoded (Brazil) | none |

## Where the scanner and the consent tool differ, and why

Two cases give different answers in the scanner and the consent tool. Both are on purpose.

**A US location with no verified state.**

- Scanner: the baseline opt-out model. It asserts no state duty, because it never claims
  a state law it could not verify. The report says so in the location's note.
- Consent tool: opt-out with the signal honored. It fails closed, because the visitor
  may be in California.

**A country complykit has not researched.**

- Scanner: no rules are compared, and the report says "No rules encoded" for that
  location.
- Consent tool: opt-in, the strictest regime, because a country that has not been
  researched gets the strictest rules.

What each regime grants before a choice comes from your config's
`categories[].defaultByRegime` (see [Consent tool config](./config.md)). Under `opt-in`,
nothing but `necessary` is ever granted by default.

**Unknown means `opt-in`.** If the source is missing, unreadable, cross-origin, slow or
broken, the visitor gets the strictest regime. That fallback cannot be configured. A
misconfigured location source makes the site stricter, never looser.

## Global Privacy Control

If the browser sends `navigator.globalPrivacyControl === true`, the tool denies every
non-necessary category by default, in every regime. A visitor's own explicit choice
still applies afterwards. The consent record stores `gpc: true`, which is your proof
that the signal was received.

This goes further than the law strictly requires. Only some states require honoring
GPC, and only for sale/sharing. There are three reasons for the stricter behavior:

- every tracked visitor counts toward state thresholds;
- analytics sent to a vendor without service-provider terms can itself count as a
  sale;
- regulators have criticized sites that honor GPC only in some regions.

The supporting research is in `plans/research-consent-law.md` §1.4 and §8.

## Sources, in order

Set the source with `regimeSource` in the config. The tool uses the first source that
gives an answer:

1. **`fixed`.** One regime applies to every visitor, and nothing else is read.
   `{ "kind": "fixed", "regime": "opt-in" }` is the safe choice when you have no
   location source.
2. **Meta tag.** Your server writes
   `<meta name="complykit-region" content="US-CA">` into the page. The tool checks this
   for every non-fixed source because it is synchronous and needs no request. With
   `{ "kind": "meta", "name": "…" }` you can choose a different name; the tool still
   checks `complykit-region` as well.
3. **`header`.** `{ "kind": "header", "header": "cf-ipcountry", "endpoint": "/.well-known/complykit-location" }`
   points to a **same-origin** endpoint that returns the location as plain text
   (`DE`, `US-CA`). The tool refuses a cross-origin endpoint. **Until the endpoint
   answers, the visitor is under `opt-in`**. When the answer arrives, the defaults
   move, but only if the visitor has not made a choice yet. The tool waits 3 seconds,
   then stays strict for the rest of that page. `header` is a label for the people
   reading the config. The tool never sees the header itself; your server does.
4. **`platform`.** On Shopify, the tool reads `Shopify.customerPrivacy.getRegion()`,
   but only if the storefront has already loaded the Customer Privacy API. Loading
   that API is the Shopify bridge's job.
5. **Unknown.** The visitor gets `opt-in`.

The tool records which source gave the answer in `ComplyKit.diagnostics.location`
(`{ source, regime, pending, gpc }`). A rescan reads it from there.

::: warning Cached HTML and the meta tag
If a CDN or page cache stores your HTML, a meta tag written at the origin is cached
together with the page. The next visitor then gets the first visitor's region. Write
the tag **after** the cache, at the edge (Cloudflare Worker `HTMLRewriter`, Netlify Edge
Function, Vercel middleware), or use the `header` endpoint instead. Give that endpoint
`Cache-Control: private, no-store`.
:::

## Recipes

Each recipe uses one of two patterns: a same-origin endpoint that returns the location
(`regimeSource.kind: "header"`), or the meta tag written at the edge (`kind: "meta"`).
You need one, not both.

### Cloudflare

Cloudflare adds `CF-IPCountry` when IP geolocation is on (the default). It adds the
state or province only when you turn on the **"Add visitor location headers"** Managed
Transform (`cf-region-code`). In a Worker, the same values are on `request.cf`
(`country`, `regionCode`).

The endpoint, as a Worker route on `example-shop.test/.well-known/complykit-location`:

```js
export default {
  fetch(request) {
    const cf = request.cf ?? {};
    const loc = cf.country ? (cf.regionCode ? `${cf.country}-${cf.regionCode}` : cf.country) : '';
    return new Response(loc, {
      headers: { 'content-type': 'text/plain', 'cache-control': 'private, no-store' },
    });
  },
};
```

Or write the meta tag into every HTML response. This works on cached pages because
the Worker runs on each request:

```js
export default {
  async fetch(request, env, ctx) {
    const res = await fetch(request);
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) return res;
    const cf = request.cf ?? {};
    const loc = cf.country ? (cf.regionCode ? `${cf.country}-${cf.regionCode}` : cf.country) : '';
    if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(loc)) return res;
    return new HTMLRewriter()
      .on('head', { element: (el) => el.prepend(`<meta name="complykit-region" content="${loc}">`, { html: true }) })
      .transform(res);
  },
};
```

`CF-IPCountry` is `XX` when Cloudflare does not know the country and `T1` for Tor. The
tool treats both as unknown, so the visitor gets `opt-in`.

### Vercel

Vercel sets `x-vercel-ip-country` and `x-vercel-ip-country-region` (the state or
province code) on requests to functions and middleware. Here is an endpoint as a
Next.js route handler at `app/api/complykit-location/route.ts`, with
`"endpoint": "/api/complykit-location"` in the config:

```ts
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  const country = request.headers.get('x-vercel-ip-country') ?? '';
  const region = request.headers.get('x-vercel-ip-country-region') ?? '';
  return new Response(country && region ? `${country}-${region}` : country, {
    headers: { 'content-type': 'text/plain', 'cache-control': 'private, no-store' },
  });
}
```

If you render pages per request, you can write the meta tag from the same two headers
in your layout. Don't do that on statically generated or ISR pages, because they are
cached (see the warning above).

### Netlify

Netlify Edge Functions get the visitor's location on `context.geo`. Put this in
`netlify/edge-functions/complykit-location.ts`:

```ts
import type { Context } from '@netlify/edge-functions';

export default (_request: Request, context: Context) => {
  const c = context.geo?.country?.code ?? '';
  const r = context.geo?.subdivision?.code ?? '';
  return new Response(c && r ? `${c}-${r}` : c, {
    headers: { 'content-type': 'text/plain', 'cache-control': 'private, no-store' },
  });
};

export const config = { path: '/.well-known/complykit-location' };
```

An edge function can also rewrite the HTML response to add the meta tag, in the same
way as the Cloudflare `HTMLRewriter` example.

### Fly.io

**Fly does not tell your app where the visitor is.** Fly's proxy adds `Fly-Client-IP`
(the visitor's IP address) and `Fly-Region`. `Fly-Region` is the Fly region that
handled the request, not the visitor's country, so don't use it as a location. Your
options:

- **Put a CDN in front of Fly** (for example, a proxied Cloudflare DNS record) and use
  the Cloudflare recipe. This is the simplest option.
- **Look up the IP on your own server** from `Fly-Client-IP`, using a geolocation
  database file that ships with the app (MaxMind GeoLite2 or DB-IP Lite; check each
  license). Then serve the endpoint or write the meta tag. Because the database is a
  local file, the lookup sends nothing to anyone. Calling a hosted geolocation API
  from your server is a different thing: it sends each visitor's IP address to that
  provider. That is a disclosure to a third party, and you should treat it as one.
- **Use `fixed`.** `{ "kind": "fixed", "regime": "opt-in" }` treats every visitor by
  the strictest rules. You lose nothing in accuracy, only the opt-out defaults for US
  visitors.

### Shopify

Use `{ "kind": "platform" }`. Shopify knows the visitor's region and reports it through
its Customer Privacy API. If the API isn't loaded yet when the tool starts, the visitor
gets `opt-in`; the [Shopify bridge](/guide/platform-shopify) loads the API and then moves
the defaults to the visitor's real regime (unless they have already chosen).

### Your own server (nginx, Apache, an app)

Any server that already knows the country (nginx `geoip2` module, a load balancer
header, an app-side lookup in a local database) can write
`<meta name="complykit-region" content="…">` into the page or serve the endpoint.
Follow the caching warning above.

## Checking it

Load a page and run `ComplyKit.diagnostics.location` in the console. You should see
`{ source: 'meta' | 'header' | …, regime, pending: false }`. If `source` is `unknown`
on a site that has a location source configured, the source is broken, and every
visitor is getting `opt-in`.
