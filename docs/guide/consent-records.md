# Consent records

When a visitor makes a consent choice, the client tool can send a small record of it
to an endpoint. If you ever have to show that a visitor consented, or that their
rejection was honored, this is the evidence. You have two options:

- **Host your own endpoint.** Any first-party URL that accepts the record below.
- **Use the complykit service's endpoint.** It is optional and runs on the service
  that scans your site: `POST /api/consent-records`.

If you do neither, the choice is still stored in the visitor's browser and still
enforced. You just have no record on your side.

## What a record contains

```json
{
  "id": "k3j9x0aa81QmZp72fD",
  "at": "2026-10-06T14:03:00.000Z",
  "kind": "withdrawal",
  "supersedes": "q8w2m5tt40AbZx19cE",
  "categories": { "analytics": false, "marketing": false },
  "configHash": "sha256:ab12cd34",
  "toolVersion": "0.1.0",
  "regime": "opt-in",
  "region": "US-CA",
  "gpc": true,
  "gpcHonored": true
}
```

`id` is a random consent id generated in the browser when the visitor chooses. It is
not tied to an account, a cookie you already have, or an IP address. `gpc` is present
when the browser sent a Global Privacy Control signal. `configHash` and `toolVersion`
say which banner configuration and tool version showed the choice.

Each record is a full snapshot of one decision:

- `kind` is `withdrawal` when the visitor had made a choice before and this one takes
  back a category they had granted (Reject all after a grant, `ComplyKit.withdraw()`,
  or a settings change that turns something off). Otherwise it is `choice`. Defaults
  that applied before any choice never count as a grant.
- `supersedes` is the `id` of the decision this one replaced. A first decision has
  none. Following `supersedes` gives the visitor's history, with no identifier that
  links it to a person.
- `gpcHonored` says whether the GPC signal counted as an opt-out under your settings
  (`gpc` is only that the browser sent it).
- `region` is where the visitor was at that moment, as a country (`DE`) or a country
  and state (`US-CA`). Never anything finer. Left out when no location was known.

`kind`, `supersedes`, `gpcHonored` and `region` are optional on the endpoint: a
client that predates them sends none, and the stored record then leaves them out.

The service stores exactly this, plus `receivedAt` (the server's clock; retention
runs on it, because `at` is the visitor's clock). It **does not store** an IP address,
user agent, cookies, referrer or page URL, and it rejects a body that carries any
field outside the list above. The IP is used for rate limiting in memory for one
minute and is never written.

## Endpoint behavior

| | |
|---|---|
| Route | `POST /api/consent-records`, JSON body (the client sends it as `text/plain`, which needs no CORS preflight) |
| Site | Taken from the `Origin` header, reduced to its registrable domain (`www.example-shop.test` → `example-shop.test`). A request without a usable Origin is refused. A `domain` field is accepted only if it matches the Origin. |
| Success | `204`, no body |
| Errors | `400` invalid or unknown field, `403` domain mismatch or site not allowed, `413` body over 4 KB, `429` rate limited (`Retry-After` set), `507` the site's file is full |
| CORS | The preflight and the response echo the requesting origin, on this route only. No credentials. |
| Auth | This route is open even when the service has `SERVICE_PASSWORD`, because a visitor's browser has no password. Everything else, including the export, stays behind it. |
| Limits | 4 KB per record, 60 per minute per client address, 1200 per minute per site, 256 MB per site. |

A retried post of an id the service already has is answered `204` like any other. The
file may hold the line twice; the export lists each id once.

Records are appended, one JSON object per line, to
`DATA_DIR/sites/<domain>/consent-records.jsonl` on the service's volume.

To accept records only for your own sites, set `CONSENT_RECORD_DOMAINS` (comma list of
domains). Unset, the endpoint accepts any site, which means anyone can write records
under any domain name; the limits above bound the damage, but an allow-list is the
real fix. Records are claims made by a browser, not signed proof, so treat the file as
supporting evidence.

## Delivery and retries

A send can fail: the visitor goes offline, the endpoint is down, or the page closes
mid-request. So the tool keeps each record in the browser (`localStorage`, key
`complykit_consent_outbox`) until the endpoint confirms it. At most five records are
kept (the oldest goes when a sixth arrives). On the next page load it drops records
older than 30 days and sends the rest again.

- A `2xx` answer confirms the record. So does a `4xx` other than `408` and `429`: the
  endpoint refused it, and sending it again would get the same answer.
- A network or CORS failure, a `5xx`, a `408` or a `429` leaves it in the outbox to be
  retried.

A resend carries the same `id`, so the export shows each record once. If the browser
blocks storage, the record is sent once and not retried.

A self-hosted endpoint must answer CORS for your site's origin (`Access-Control-Allow-Origin`).
The browser hides the answer from the page otherwise, the tool cannot tell the record
arrived, and every record is retried until it ages out. The complykit service does this
already.

## Retention

`CONSENT_RECORD_RETENTION_DAYS` sets how long records are kept. **The default is 1825
days (5 years).** A sweep runs at boot and hourly and removes lines received before
the cutoff. This is separate from `RETENTION_DAYS` (0 by default: scans are kept for good), which only
covers scan jobs. Pick a period with your counsel: it should cover the limitation
period for claims you want to defend against, and not be longer than you can justify,
since the records are personal data in some jurisdictions. Five years is a starting
point, not legal advice. The Fly volume's daily snapshots are kept five days, so
export regularly if these records matter to you.

## Exporting

```bash
curl -u :$SERVICE_PASSWORD "https://<service>/api/sites/example-shop.test/consent-records?format=csv" -o consent.csv
curl -u :$SERVICE_PASSWORD "https://<service>/api/sites/example-shop.test/consent-records?format=jsonl" -o consent.jsonl
```

`format` is `csv` or `jsonl` (the default). Both list one row per consent id; a retried
post that arrived twice appears once. The CSV starts with `id,at,receivedAt,kind,supersedes,regime,region,gpc,gpcHonored,configHash,toolVersion`, then one `category:<id>` column per
category seen, with `true`/`false`, and an empty cell where a record did not include
that category or field. An unknown site is a `404`.
