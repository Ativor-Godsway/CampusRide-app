# Road routes between campus zones

Written for: whoever runs the precompute and chooses the routing provider.

Pickups and drop-offs are our 15 campus zones, so there are only 210 possible
trips (15 × 14 — A→B and B→A are stored separately because one-way roads make
them differ). Instead of asking a routing service on every trip, we ask **once
per pair**, store the road as an encoded polyline in `ZoneRoute`, and the apps
draw it from `GET /zones/routes`. A pair without a stored route is drawn as a
straight line, so nothing breaks before the precompute has run.

Since exact pins (October 2026) a trip's real road between its pins comes
from OSRM per trip — see [Routes between exact pins](#routes-between-exact-pins-per-trip)
below. The zone routes remain the instant fallback and the basis of the
drive-time maths.

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

## Routes between exact pins (per trip)

Since exact pickup and drop-off pins (October 2026), a trip no longer goes
zone centre to zone centre, so its road can't all be precomputed. The apps
ask the server for the road through a trip's own points —
`POST /routes/legs` with 2–10 `{ latitude, longitude }` — and the server
([services/routing/pointRoutes.ts](../apps/server/src/services/routing/pointRoutes.ts)):

1. answers from memory, or from the `PointRoute` table, when it has routed
   those points before (each point rounded to ~11 m, so a place picked twice
   is one request);
2. otherwise makes **one** OSRM request through all the points (OSRM returns
   each leg's time too), with a 2.5 s timeout, and keeps the answer;
3. never calls OSRM more than once a second from one server. A request that
   would come sooner, times out or fails gets the **fallback** at once: the
   stored zone routes above with their ends moved to the pins. The fallback
   is not kept, so the next request for those points tries OSRM again.

Drive-time maths for dispatch and the 5-minute detour rule still uses the
zone routes, unchanged.

### How busy we are, and when we'd outgrow the free server

Every OSRM call is logged as `osrm_call` with the day's running count, and
every fallback as `osrm_fallback`; past `ROUTING_DAILY_WARN_AT` (3,000) in a
UTC day each further call logs at **warn** level. Search the Render logs
for `osrm_call` to see the number.

A trip costs roughly **3–8 calls**: the rider's preview (pickup → drop-off,
often cached), the driver's way to each pickup (it starts at the driver's
live position, so it's rarely cached, and it's re-asked only when the driver
leaves the drawn road), and the trip's stops. At 100 trips a day that is
about 300–800 calls, which is light use by OSRM's policy.

Move to our own OSRM when any of these happens:

- the daily count is regularly over **~3,000** (the warnings start), or
- `osrm_fallback` is more than ~10% of `osrm_call` at busy times (the
  one-a-second limit is being hit, so riders see the approximate road), or
- OSRM answers 429 or blocks us.

Self-hosting is cheap: OSRM's Docker image with the Ghana extract from
Geofabrik (about 100 MB) runs on a 2 GB VPS (~US$6–12 a month). Point
`OSRM_BASE_URL` at it and set `ROUTING_MIN_INTERVAL_MS=0`; nothing else
changes.

Settings (all optional): `OSRM_BASE_URL`, `ROUTING_DISABLED=true` (serve
the fallback only), `ROUTING_TIMEOUT_MS`, `ROUTING_MIN_INTERVAL_MS`,
`ROUTING_DAILY_WARN_AT`, `RATE_LIMIT_ROUTE_LEGS` (per user per 15 minutes,
default 120). Under the test suite OSRM is never contacted.
