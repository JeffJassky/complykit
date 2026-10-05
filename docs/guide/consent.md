# Consent & tracking by visitor location

`complykit consent` finds out what a site actually does with visitor data —
per visitor **location** and per consent **scenario** — and reports it against
the rules for that location: EU ePrivacy Art. 5(3), UK PECR reg. 6, the
California CCPA regulations and other US state opt-out-signal laws, and (as
*exposure* for counsel, never as violations) the California, Florida and
Pennsylvania wiretap statutes.

```bash
npx complykit consent --url https://shop.example.com
```

With no config, it runs from this machine's own location, verifies where that
is, and lists every other location as not tested.

## How it works

1. **An external browser, not a page script.** complykit drives a real Chromium
   (Playwright) as a first-time visitor and records at the browser level: every
   request from the page, its frames (including cross-site and `srcdoc`
   frames), workers and service workers; who caused each one (the call stack,
   then the chain of scripts that inserted those scripts); every cookie
   including HttpOnly ones and which response or script set it; storage in
   every frame; and page-exit beacons, which a small observer recovers on the
   next same-origin page because the browser's own events miss them.
2. **Verified locations.** Each location routes through its own proxy/VPN
   exit (`--proxy de=socks5://…`). Before anything is attributed to a place,
   the exit is looked up in **two** geolocation sources *through that same
   proxy*; only a **verified** location produces findings. A mismatch or a
   failed lookup is reported as not tested. A US state is trusted only when
   both sources agree on it — otherwise findings stay at country level.
3. **Scenarios.** Each runs in a brand-new browser profile with a short
   journey (land, dwell, scroll, a listing/product/cart page, one more
   same-origin page to flush exit beacons):

   | Scenario | What the browser does |
   |---|---|
   | `do-nothing` | load and wait; never touch the banner |
   | `browse` | full journey; never touch the banner |
   | `dismiss` | close the banner without choosing, then browse |
   | `reject` | reject all, reload, browse |
   | `accept` | accept all, browse |
   | `partial` | accept analytics only, browse |
   | `withdraw` | accept, browse, reopen settings and withdraw, reload, browse |
   | `gpc` | send Global Privacy Control from the first request |
   | `opt-out-all` | GPC + reject + the site's opt-out link, then browse |
   | `opt-out-link` | find and walk the "Do Not Sell or Share" link (never submits) |
   | `return-visit` | reject, then come back in the same profile |
   | `markers` | fake ad-click IDs in the URL; type marker text into search/email fields without submitting |

   Defaults per location: EU/UK get the banner scenarios plus withdraw,
   partial, return visit and markers; US states with opt-out-signal laws get
   reject, the signal, "opt out every way" and the link walk; other US states
   get reject, the signal and markers. `--quick` runs a reduced set with
   shorter visits.
4. **Banner driving** uses `@duckduckgo/autoconsent` (rules for hundreds of
   consent tools) with its "hide the banner" rules off — hiding is not
   rejecting — and a heuristic fallback. Every click is confirmed by reading
   the stored consent state back (Google Consent Mode, OneTrust, Cookiebot,
   Shopify Customer Privacy, …); a click that didn't change it marks the
   scenario not tested rather than producing misleading evidence.

## From facts to findings

- **Every outside party is identified** — by the knowledge base when
  recognized, otherwise by what it did. The tracker pattern doesn't need a
  name: store a long-lived ID, then send it plus the page address to an outside
  domain on every page. Unrecognized parties showing it are reported as
  *unrecognized, behaves like a tracker* and queued for research.
- **What each request carried** is classified by value, not parameter name:
  the page address, the title, an ID the browser stores (and which cookie it
  came from), ad-click IDs, and typed marker text — plain, URL-encoded,
  base64 or hashed (the normalized-email SHA-256 ad platforms use).
- **What each vendor was told** is decoded from its own requests (Google
  `gcs`/`gcd`/`npa`/`rdp`, Meta Limited Data Use, IAB strings). A Consent Mode
  "advanced" ping with every signal denied is *needs review*, not a violation.
- **Why it wasn't held back** decides the fix: in the site's own markup; an
  HTML tag that leaks past script gating (`<img>`, `<iframe>`, preload); injected
  by another script (a tag manager or app — named); a platform sandbox or
  worker; or a first-party subdomain whose DNS points at a tracker.

Each finding is **violation**, **needs review**, or **exposure** (a wiretap
theory, labelled for counsel). One finding per party per jurisdiction, listing
every location × scenario where it happened. US opt-out findings stay *needs
review* until you set the hand-set `ccpa-covered` / `us-state-privacy-covered`
tag — the law's thresholds aren't observable from a browser.

## The report

`<run>/consent-report.html` (self-contained) and a JSON model next to it:

1. **Overview and priorities** — a plain-language briefing with grouped action
   counts and suggested first steps. Problems, uncertain observations, research
   tasks and legal-review items stay distinct.
2. **Action plan** — what happened, why it matters, who can help, what to change
   and how to check the fix. Repeated observations with the same tool, behavior,
   certainty and fix location are grouped. Original findings, legal references,
   implementation details and evidence are retained in collapsed sections.
3. **Cookies and browser storage** — names, associated tools, provisional
   purposes, retention and items needing classification. A finding about a
   tool does not automatically mean every cookie it uses is a violation.
4. **Tracking tools and outside services** — purposes, observed information,
   next steps and links to related actions. Provisional vendor entries and
   research requests are clearly identified.
5. **Visitor experience** — results explained through visitor actions such as
   rejecting cookies or withdrawing permission. Failed choices and untested
   actions are visible. No finding recorded is not a verified pass.
6. **Scan coverage and evidence** — recorded locations and limitations,
   including flows a browser cannot see, plus an expandable test matrix,
   network logs, timelines and scan metadata. Evidence links need the
   accompanying run files. Values are redacted unless you pass `--raw-evidence`.

The HTML includes a short disclaimer and contextual notes about uncertainty.
The JSON model and its original per-finding counts remain unchanged; the HTML’s
grouped action counts and separate tool counts can overlap and are labeled.

Re-render any time: `complykit report --format consent-html|consent-md|consent-json`.

## The knowledge base and research

A party is only as well described as the knowledge base's entry for it. complykit
ships a seed set of common vendors (marked *proposed* in reports until someone
confirms them); everything else is learned once, per vendor, and reused on every
later scan of every site.

```
scan ──► queue ──► proposal (cited) ──► a person confirms ──► recognized next scan
```

- **Queue.** Each consent scan adds the parties it could not recognize to a
  research queue, and recognized ones that behaved differently than their entry
  says (a cookie or a sensitive field the entry doesn't list). One item per
  vendor domain, with the evidence from every site it was seen on. The queue
  lives outside the project, at `~/.complykit/kb` (or `COMPLYKIT_KB_DIR`,
  or `--kb-dir`), because it names the sites you scanned.
- **Proposal.** `complykit kb research` asks the Anthropic API (with web search;
  needs `ANTHROPIC_API_KEY`) to research the most widespread open items and
  propose entries **with cited sources**. Without a key, `complykit kb packet <domain>`
  prints the same brief for a person or a coding agent, and
  `complykit kb propose <domain> --file result.json --by <who>` imports the result.
  What complykit observed outranks a vendor's documentation; where they disagree,
  the proposal records it.
- **Confirmation.** `complykit kb proposals` lists what's waiting.
  `complykit kb confirm <id> --by <you>` accepts one, optionally corrected
  (`--category advertising,identity-resolution`); `kb reject <id> --reason …`
  sends it back with the reason in view for the next attempt. A seed entry can be
  confirmed the same way, by its id. Agents never confirm their own proposals.
- **Reuse.** Only confirmed entries join the knowledge base, from the next scan
  on; the queue item is marked resolved.

```bash
complykit kb queue                 # most widespread first
complykit kb research --top 5      # or: kb packet <domain> → kb propose
complykit kb proposals
complykit kb confirm p-pixelco.io-1 --by jeff
```

`complykit kb ingest <run-dir…>` adds earlier runs to the queue; `kb dismiss <domain>`
removes noise (the site's own infrastructure) without an entry. The web
service exposes the same queue and review under **Knowledge base**.

## Configuration

```js
// complykit.config.js
export default {
  properties: [{
    id: 'shop',
    targets: { public: { url: 'https://shop.example.com' } },
    tags: ['ccpa-covered'],               // hand-set, after counsel confirms
    consent: {
      locations: [
        { id: 'de', country: 'DE', proxy: { server: 'socks5://127.0.0.1:1081' } },
        { id: 'us-ca', country: 'US', region: 'CA', proxy: { server: 'http://gluetun-ca:8888' } },
        { id: 'us-fl', country: 'US', region: 'FL' },
      ],
      journey: { paths: ['/collections/all', '/products/example', '/cart'] },
      knowledgeBase: {
        entries: './kb/confirmed.json',   // extra entries for this site (the kb store's are used too)
        overrides: [{ id: 'intercom', categories: ['functional'], note: 'support portal only' }],
      },
    },
  }],
};
```

Running through proxies requires `--authorized`: scanning needs the site
owner's authorization, in writing when residential proxies are used.

## Limits, stated

The report never says a site is fine. It cannot see server-to-server flows,
what vendors do afterwards, contracts, backend consent records, unvisited
pages, storage inside sandboxed frames, or `navigator.globalPrivacyControl`
inside workers (the `Sec-GPC` header is still sent) — each run lists these as
not tested.
