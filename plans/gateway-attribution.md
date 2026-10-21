# Gateway attribution (2026-10-21)

Field case: allen-heath.com shows `on.aws` ("requests only, no cookies", loaded by Meta Pixel id
`1657910171216690` / `fbevents.js`, posting to `…ecs.us-east-1.on.aws/events?cee`) as an unknown
tool with a "Decide: what is on.aws?" task. It is Meta's Conversions API Gateway: Meta's own script
sending Meta's events through a first-party-ish relay. complykit must recognise it itself; nobody
should have to answer "what is on.aws?". Generic rule, not a Meta one-off.

## Rule — tier: Sonnet

A request to a host no knowledge-base entry matches is attributed to a known tool when BOTH hold:
1. its initiator chain contains a URL matching one of that entry's `match.gateways[].loaders`
   (regex sources over the loader script URL, query stripped), and
2. its path matches one of the same gateway's `paths` (regex sources over the pathname).

Then the party is a **gateway of that entry**:
- `partyId = 'gateway:<entry.id>:<registrableDomain of the request host>'`
- `label = '<entry.vendor> (server gateway on <registrableDomain>)'`, `owner = entry.owner`
- `entry` = that entry; `recognized: true`; `categories = [...entry.categories]`;
  new field `gatewayOf: entry.id` on PartyFacts / PartyInventoryItem (zod: optional string).
- `domain`/`hosts` = the gateway's own (so cookies it sets stay attributed to it, and the
  classKey is per gateway domain).

Not a gateway (control cases stay `unknown:<domain>`): the chain lacks the loader; the path
doesn't match; the host IS matched by another KB entry (that entry wins — gateways only apply
to otherwise-unknown hosts). The host being the site's own domain does NOT exempt it: the
`partyFor` first-party short-circuit runs the gateway check first — a CAPI gateway on
`capi.example-shop.test` is Meta's, not the site's.

Everything that looks a party up by id must resolve a gateway id to its entry:
`kbEntryOf(kb, partyId)` in `src/registry/kb/index.ts` (exported from the registry) — exact id,
else `gateway:<id>:…` → the entry with that id. Use it in `knownTrackerReason`
(tracker-reason.ts), `refuseNecessaryTrackers`, owner-report `judge.base`, and every other
`kb.entries.find((e) => e.id === partyId)` (grep for them).

Schema: `KnowledgeEntry.match.gateways?: Array<{ loaders: string[]; paths: string[]; note?:
string }>` (src/registry/kb/schema.ts). Seed (src/registry/kb/entries.ts), each with a citable
`sources` URL or it is NOT added:
- `meta.pixel`: loaders `['connect\\.facebook\\.net/[^"\'\\s]*fbevents\\.js']`, paths
  `['^/events(?:/|$)']` — Conversions API Gateway (vendor docs on developers.facebook.com;
  WebFetch to confirm the URL resolves before citing it).
- Google server-side tagging (gtag/js or gtm.js loader; paths `^/g/collect`, `^/gtm\\.js`): only
  if the KB's GA4 / GTM entries make the attribution unambiguous and the docs are cited;
  otherwise skip and say so in the report.

Reports: a gateway party is classified (its entry's purpose) — no decision task, judged like its
tool (an advertising gateway firing before a choice in California is a mismatch). Technical
report tool card: "<vendor>'s server gateway on <domain>: recognised because <vendor>'s script
loaded it and it posts to <vendor>'s event endpoint". Research queue: not queued (recognised).

Tests: `test/gateway-attribution.test.ts` (contract, written first).

## Chain order and the fold (review fixes, 2026-10-21)

- The loader must come BEFORE the first URL on the site's own registrable domain in the initiator
  chain (nearest initiator first): `[fbevents.js, site.js]` is a gateway, `[site.js, fbevents.js]`
  is not. `lookupGateway(kb, chain, pathname, siteDomain)` truncates the chain at that URL.
- A gateway-only change item folds into the loader's fixing task when one exists; else into the
  loader's own `behavior-mismatch` task; else it stays a task of its own, titled for the loader
  ("Meta Pixel's server gateway on on.aws …") — a gateway's violation is never discarded. Only
  `behavior-mismatch`, `needs-a-look` and `accepted-exposure` items fold (an accepted exposure only
  into a task that removes it); `clear-server-cookie`, `call-consent-api` and other kinds keep
  their own task. A gateway that keeps its task gets no separate "Confirm in the browser" task.

## Known limits

- `fbevents.js` served from a first-party proxy or CDN (not `connect.facebook.net`) is not matched
  by the seeded loader; a gateway behind such a script stays `unknown:<domain>` (status quo).
- A gateway on the site's own subdomain has `domain === siteDomain`, so the cookies it sets are
  treated as first-party, as today (the party is the tool's gateway, but the cookie's
  first-party classification and the DNS/CNAME logic are unchanged).
- Redirect hops are not followed for the gateway check: only the request's initiator chain is read.
