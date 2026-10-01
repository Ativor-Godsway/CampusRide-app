# Road routes between campus zones

Written for: whoever runs the precompute and chooses the routing provider.

Pickups and drop-offs are our 15 campus zones, so there are only 210 possible
trips (15 × 14 — A→B and B→A are stored separately because one-way roads make
them differ). Instead of asking a routing service on every trip, we ask **once
per pair**, store the road as an encoded polyline in `ZoneRoute`, and the apps
draw it from `GET /zones/routes`. A pair without a stored route is drawn as a
straight line, so nothing breaks before the precompute has run.

## Which provider

| | OSRM public demo | openrouteservice (free "Standard") | Mapbox Directions |
|---|---|---|---|
| Account / key | **None** | Free HeiGIT account + API key | Account + access token |
| Free limits | No published number; "no heavy use", blocked if you affect stability | 2,000 directions/day, 40/min | 100,000 requests/month |
| Storing results | Not restricted by the policy | OSM data (ODbL): allowed with attribution | **Not allowed** — results may not be stored, and only shown on a Mapbox map |
| Commercial use | Allowed if the app is publicly available (not behind a paywall) and shows attribution | Couldn't confirm from the official pages (they only render in a browser) — check the terms before relying on it | Paid plans |
| Our 210 requests | ~4 minutes at 1/second | ~6 minutes at 40/minute | — |

Sources: [OSRM API usage policy](https://github.com/Project-OSRM/osrm-backend/wiki/API%20Usage%20Policy),
[openrouteservice plans](https://openrouteservice.org/plans/),
[openrouteservice restrictions](https://openrouteservice.org/restrictions/),
[Mapbox API caching](https://docs.mapbox.com/help/dive-deeper/api-caching/).

**Recommendation: OSRM.** It needs no account or key, 210 requests once is
nowhere near "heavy use", storing the result isn't restricted, and our app is
publicly available. In exchange we must show attribution where routes are
drawn: "© OpenStreetMap contributors · Routes: OSRM". If OSRM's demo is down
or blocks us, openrouteservice is the fallback (sign up at
<https://openrouteservice.org/dev/#/signup>, create a key, and pass it as
`ORS_API_KEY`). Mapbox is ruled out: its terms forbid storing Directions
results, which is the whole design.

## Commands

The production database must have the
`20261001120000_trip_stops_and_zone_routes` migration first.

```bash
# Dev database (apps/server/.env.development), OSRM:
npm run routes:precompute --workspace apps/server -- --provider osrm

# A trial run of 5 routes first, if you like:
npm run routes:precompute --workspace apps/server -- --provider osrm --limit 5

# Retry only what failed / is missing:
npm run routes:precompute --workspace apps/server -- --provider osrm --only-missing

# openrouteservice instead (key you created):
ORS_API_KEY="…" npm run routes:precompute --workspace apps/server -- --provider ors

# Production — deliberately, once, with the URL you export yourself:
export PROD_URL="postgresql://…"   # from Render, this shell only
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
  npm run routes:precompute --workspace apps/server -- --provider osrm
```

It prints each route as it saves it and a summary. It only writes `ZoneRoute`
rows. Re-run it only if zones change.
