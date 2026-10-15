# Banner analytics

When you install the consent tool with the hosted line ([Installing the consent
tool](./consent-tool.md)), the banner can report how it is doing: how often it is
shown, what visitors choose, how long they take. This page says exactly what is sent,
what is stored, and what is never collected, in terms you can quote in your own privacy
policy. It describes how the tool is built. It is not legal advice, and whether a
description is enough for your situation is a question for your own counsel.

## In one paragraph

The banner sends a small message when the page is hidden or closed. The message says
what the banner did: it loaded, it was shown, the visitor opened the settings, the
visitor chose accept, reject or custom, and roughly how long that took. It contains no
cookie, no identifier, no page address and nothing the visitor typed. The server turns
each message into a handful of counters, adds them to a daily total for your site, and
throws the message away. There is no record of any individual visit.

## What the beacon sends

The beacon exists only when the served config has an `analytics.endpoint`, which the
hosted script always sets. Without it the tool sends nothing and registers nothing.

One `POST`, with a plain-text body, at most 4 KB. The body is exactly this shape:

```json
{
  "v": 1,
  "h": "<the hash of the config the visitor is running>",
  "tv": "<the tool version>",
  "r": "opt-in",
  "ev": [
    { "t": "load", "d": 0, "gpc": 0 },
    { "t": "shown" },
    { "t": "open", "via": "banner" },
    { "t": "decide", "a": "custom", "via": "settings", "ms": 4210,
      "cats": { "analytics": true, "advertising": false } }
  ]
}
```

| Field | What it is |
|---|---|
| `v` | Format version, always `1`. |
| `h` | The hash of the config the page ran. Identifies the banner wording and settings, not the visitor. |
| `tv` | The tool version. |
| `r` | The rule set that applied to this visitor: `opt-in`, `opt-out-signal` or `opt-out`. |
| `load` | The tool started on a page. `d` is 1 if the visitor had already made a choice, else 0. `gpc` is 1 if their browser sent a Global Privacy Control signal. |
| `shown` | The banner became visible. |
| `open` | The settings layer was opened, from the `banner`, the Privacy `choices` control, or the `api`. |
| `decide` | The visitor chose. `a` is `accept`, `reject` or `custom`. `via` is `banner`, `settings` or `cmp` (an existing banner the tool follows, in add-on mode). |
| `ms` | Milliseconds from the banner appearing to the choice. Left out if no banner was shown on this page. This is the only number the browser measures. |
| `cats` | Only for `custom`: which optional categories were switched on or off. |

That is the complete list. The browser sends it when the page is hidden or closed
(`pagehide`, or the tab going to the background), once for events not yet sent. There
is no timer and no retry. The request is sent without cookies.

## What is stored

For each site, each UTC day and each config hash, one set of counters. Examples of the
counter names:

- `load`, `load:decided`, `load:gpc`
- `shown`
- `open:banner`, `open:choices`, `open:api`
- `decide:accept:banner`, `decide:reject:settings`
- `ttd:accept:2-5s` (time to decide, in buckets: under 2 s, 2-5 s, 5-10 s, 10-30 s,
  30-60 s, 1-5 min, over 5 min)
- `cat:analytics:on`, `cat:analytics:off`
- `regime:opt-in`
- `geo:DE:shown`, `geo:US-CA:decide:reject`

The counters are whole numbers that go up. The exact milliseconds are used to pick a
bucket and then discarded.

**Region.** The only location is a country, and where available a region code, taken
from the headers the content delivery network in front of our host adds to the request.
It is used only when the host is configured to trust those headers. Otherwise every
count is recorded under "unknown" (`XX`). The host never works a location out from the
visitor's IP address.

**Config snapshots.** The first time the host serves a given config, it keeps a copy,
so a count can be shown beside the banner wording it measured. A config describes your
banner and vendors. It holds nothing about visitors.

**Rejected messages.** A message is dropped whole if it comes from a site we have not
served that config hash to, if it is over 4 KB, or if it exceeds a rate limit. Single
events that do not validate are dropped alone. Dropped messages are not stored.

**Retention.** Counters have no automatic expiry yet. They contain no personal data
(see below), so there is nothing to expire for a visitor's sake.

## What is never collected

- Cookies. The script and the beacon endpoint neither set nor read any, and the beacon
  is sent without them. One exception while the host runs on its default address
  (`*.ondigitalocean.app`): DigitalOcean's edge network, not complykit, adds Cloudflare's
  bot-management cookie `__cf_bm` (HttpOnly, about 30 minutes, used only to tell bots
  from browsers) to responses on that domain. It goes away when the host moves to its
  own domain with bot management turned off.
- IP addresses. Not logged, not stored with the counters. (The host keeps a count of
  recent requests per IP in memory, to limit abuse. It is never written to disk or to
  a log.)
- Identifiers of any kind: no visitor id, no session id, no device id, nothing
  generated and kept to recognise a returning visitor.
- Fingerprinting inputs: no screen size, language, timezone, user agent, or similar.
- Page addresses: no URL, path, query string, referrer or page title. The tool never
  reads the page address for analytics, and every request to our host (the install
  line, the files it loads, the beacon) asks the browser not to send a referrer.
- Anything a visitor typed.
- The message itself. The body is read, turned into counters, and discarded. It is not
  logged.

Because there is no identifier, the counters cannot tell you how many *different*
people saw the banner. That is a deliberate limit. "Loads" counts page views.

## Who sees it

You see the counters for your own site, per config version, in the service. They help
you compare banner wording and layout. They carry nothing that identifies a visitor.

## A paragraph you can adapt for your privacy policy

> We use a consent banner provided by ComplyKit. When a visitor loads a page, the
> banner's script is delivered from ComplyKit's servers, so ComplyKit receives the
> technical requests the visitor's browser makes to fetch it and to send the counts
> described below, including the IP address. ComplyKit does not store IP addresses with banner statistics, does not set
> or read cookies of its own, and does not receive the address of the page being viewed. The
> banner also sends ComplyKit anonymous counts about its own use (whether the banner
> was shown, which choice was made, how long it took, the visitor's approximate
> country or region where available, and the version of the banner). These counts
> contain no identifier and cannot be linked to an individual.

Review this against your own set-up and local requirements before you publish it.
Whether and how to describe the consent tool vendor in your notice, in your records of
processing, or in an agreement with the vendor depends on where you operate. We do
not give that advice here.

If you self-host the tool instead ([Self-hosting](./consent-tool.md#_9-self-hosting)),
no request goes to us, and there is no beacon unless you add an `analytics.endpoint`
yourself.

## See also

- [Installing the consent tool](./consent-tool.md): the hosted line and the precautions
- [Consent records](./consent-records.md): the separate, optional record of each choice
- [Consent tool config](./config.md#analytics): the `analytics` field
