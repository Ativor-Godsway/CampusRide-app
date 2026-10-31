# @rida/admin

The CampusRide admin site: an operations dashboard (Vite + React SPA) behind
one login. A left sidebar on a computer, a bottom tab bar on a phone.

Pages: Overview, Live map, Rides, Supply & demand, Cancellations, Drivers
(including the approval queue), Cash owed, Riders, Places, Safety,
Notifications, Settings. What each is for and how to do the common jobs:
[docs/runbooks/admin-dashboard.md](../../docs/runbooks/admin-dashboard.md).
What every number means: [docs/admin-metrics.md](../../docs/admin-metrics.md).
The designs it follows: [docs/mockups/admin](../../docs/mockups/admin).

It has no backend of its own: it calls the CampusRide API's `/admin/*`
routes (ADMIN accounts on `ADMIN_PHONE_ALLOWLIST` only). Sign-in is a passkey
first, a phone code as the fallback.

## How it's built

- `src/pages/`: one file per page, plus the ride, driver and rider detail
  panels (opened by `?ride=`, `?driver=`, `?rider=` on any page).
- `src/shell/`: sidebar, tab bar, top bar (launch mode pill, global search).
- `src/components/`: StatTile, Chip, DataTable, DetailDrawer, PeriodPicker,
  ConfirmDialog, Toast, CSV download.
- `src/charts/`: small hand-written SVG charts; their maths in `math.ts`.
- `src/map/`: the campus map, drawn as SVG from our own data (service area,
  the routing engine's road graph, gates, places). No map tiles, so no outside
  host in the CSP. The place editor (Places) still uses Leaflet with
  OpenStreetMap tiles, as before.
- `src/lib/`: money (`cedis()`), Accra time, periods, the router, polling.
- `src/screens/`: the screens kept from before (login, approval queue, place
  editor, notifications, launch settings, passkeys, rate limits, account
  deletion, admin sign-ins), restyled.
- Figtree is self-hosted (`src/assets/fonts`, OFL): the CSP allows fonts from
  this site only.

Pages refresh every 60 s while the tab is visible (the live map every 5 s,
answered from the server's memory); the server caches aggregates for 60 s.

## Running it locally

```bash
npm run db:deploy:dev --workspace=apps/server       # local database up to date
npm run seed:dashboard:dev --workspace=apps/server  # optional: two weeks of made-up data
npm run dev:server                                  # API on http://localhost:3000
npm run dev:admin                                   # http://localhost:5173
```

Sign in with an ADMIN account (the seed makes "Seed Admin"; or promote one
with `apps/server/src/scripts/seedAdmin.ts`). In development the code goes to
the dummy provider: read it in the server log.

## Checks

```bash
npm run typecheck --workspace=apps/admin
npm run lint --workspace=apps/admin
npm run test --workspace=apps/admin     # vitest: helpers, chart maths, map maths, components
npm run build:admin                     # typechecks, then emits apps/admin/dist
```

`VITE_API_URL` is inlined into the bundle **at build time**, so pointing the
site at a different API means a rebuild. The session lives in `localStorage`
(shared by the site's tabs) and ends after an idle hour or 12 hours.
