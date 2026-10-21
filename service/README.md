# complykit service

The internal web service and the hosted consent script host. See `plans/` for design.

## GeoIP (GET /geo)

`GET /geo` tells the hosted consent script where the visitor is (`US-CA`, `DE`, or empty).
It reads the visitor IP only from the header named by `GEO_IP_HEADER` (`do-connecting-ip` on
DigitalOcean App Platform), never `x-forwarded-for`, and looks it up in the mmdb file at
`GEO_DB_PATH`. `Dockerfile.host` downloads that file at build time. With `TRUST_CF_GEO=1`,
Cloudflare's `cf-ipcountry` / `cf-region-code` win. The IP is not logged or stored. A missing
database means an empty answer (the client then treats the location as unknown).

IP geolocation by [DB-IP](https://db-ip.com) (IP to City Lite, CC BY 4.0).
