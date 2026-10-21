# Campus places, exact pins and the service area

Written for: whoever seeds and maintains the place list, and anyone working
on booking, dispatch or the trip maps.

## How it fits together

- **Riders choose exact points**: live GPS, a campus place from search, or a
  pin dropped on the map. The ride stores the pin (`pickupLat/Lng`,
  `dropoffLat/Lng`), a label ("Balme Library", "Near Volta Hall", "Pinned
  location"), the place id when one was chosen, and an optional note for the
  driver (`pickupNote`, max 140 characters).
- **Zones stay, invisibly.** The server works out each ride's
  `pickupZoneId`/`dropoffZoneId` itself, as the zone whose centre is nearest
  the pin; it ignores any zone an app sends alongside a pin. Dispatch,
  eligibility, shared matching, fares, stop ordering inputs, the 5-minute
  detour rule and the zone routes all keep running on zones.
- **Old app builds** send zone ids only and get exactly the ride they always
  did, with null pins; the apps draw such a ride at the zone centre.
- **Who sees a pin**: the rider, their assigned driver and admins. A driver
  deciding whether to accept gets place names only (the request list, the
  `ride:broadcast` event); the add-rider preview shows the new rider at the
  named place their pin is at or near, not the pin; a rider sharing a car
  sees only their own pins; the public `/track` page shows names, never
  coordinates. The rules live in
  [routes/ridePins.ts](../apps/server/src/routes/ridePins.ts).

## The service area

A polygon in [packages/shared/src/geo/serviceArea.ts](../packages/shared/src/geo/serviceArea.ts):
the OSM campus boundary pushed out 200 m — the Legon campus only. Off-campus
service (Accra Mall and the like) is a future feature, and means extending
this polygon. Pickups and drop-offs outside it are refused (`422 OUTSIDE_SERVICE_AREA`, with a sentence the app shows
as-is), and since October 2026 a driver outside it gets no zone and can't go
online (it used to be "within 2 km of a zone centre"). The server serves it
at `GET /service-area`. To change it, edit the list there.

## The place list

`Place` rows: name, aliases (search words), position, category (hall,
hostel, faculty, gate, food, landmark, other), zone (nearest, recomputed
when a place moves) and `isActive`. Seeded from OpenStreetMap; edited in the
admin site's **Places** tab, where every change is audit-logged
(`place.create`, `place.update`, `place.move`, `place.deactivate`,
`place.reactivate`). Places are never deleted; deactivating hides one from
search and keeps history intact (a ride keeps its own copy of the name and
pin).

Wherever places are shown, show **"© OpenStreetMap contributors"**
(`PLACES_ATTRIBUTION` in `@rida/shared`). The data is ODbL.

### 1. The list

Reviewed by the owner on 2026-10-12: 162 places, campus only (the
off-campus spots and International House removed; Legon Barrier without
the "West Gate" alias).

[apps/server/prisma/data/campus-places.csv](../apps/server/prisma/data/campus-places.csv)
— name, category, latitude, longitude, aliases (`|`-separated), source, note.
Rows with a note want a second look. Edit the file directly: rename, fix a
category, delete a row, add aliases. A position can be checked by pasting
`latitude,longitude` into openstreetmap.org's search box.

It was made by `npm run places:fetch --workspace apps/server`, which asks
Overpass for every named feature inside the campus boundary plus a short
off-campus allowlist, and applies the rules in
[scripts/places/osmPlaces.ts](../apps/server/src/scripts/places/osmPlaces.ts)
(what counts as a place, renames, aliases, duplicates merged). Re-running
it overwrites the CSV, so change the rules rather than the CSV if you mean
to re-fetch. An edit to the list needs a review again.

### 2. Seed

```bash
# Dev (local Postgres from .env.development.local, or the dev branch):
npm run places:seed:dev --workspace apps/server

# Production — after the migration, deliberately, with the URL you export:
export PROD_URL="postgresql://…"   # from Render, this shell only
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
  npm run places:seed --workspace apps/server -- --dry-run
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
  npm run places:seed --workspace apps/server
```

Re-running is safe: a place already there (same `source`) is left alone,
because after seeding the admin screen is where places change. `--update`
overwrites them from the CSV; `--deactivate-missing` hides seeded places
you removed from the CSV. Places are put in the nearest zone IN SERVICE.

## Zones: real positions, one renamed, one retired

The 15 zones were seeded with approximate centres packed into ~800 m; on
the map the same places spread over ~4.5 km. `zones:realign`
([scripts/realignZones.ts](../apps/server/src/scripts/realignZones.ts))
applies the owner's decisions of 2026-10-12, in one transaction:

- **Moves** 14 zones to their OpenStreetMap positions (148 m to 2.3 km).
- **Moved** "UG Medical Centre (UGMC)" to the UGMC on campus (originally
  seeded as "Medical School (UGMS)"; the rename is now baked into
  `seed.ts`).
- **Retires** "Accra Mall Junction" (off campus) by setting
  `Zone.retiredAt`. The row stays for old rides, which still show its
  name. Nothing new uses it:
  - pins are only ever derived to zones in service (`getActiveZones`);
  - `GET /zones` and `GET /zones/routes` leave it out, so apps never offer
    it or compute a driver into it;
  - an old app booking it by id gets `400 ZONE_NOT_SERVED`;
  - a driver app reporting it (`/driver/availability`, `/driver/zone`) is
    counted in the in-service zone nearest it (`servedZoneId`);
  - adjacency edges touching it are ignored by dispatch and the request
    list, and drivers whose zone is retired are never eligible;
  - places and the place seed use zones in service only; the realign
    re-zones every place and moves any driver still in it;
  - `routes:precompute` and the realign skip it.
- **Moved** "James Topp Nelson Yankah Hall (TF Hall)" to TF Hall, to serve
  the north of campus (originally seeded as "Botanical Gardens Gate"; the
  rename is now baked into `seed.ts`). USSD lists it under Halls.

It is idempotent: a second run reports 0 m for every zone and changes
nothing. Re-run `routes:precompute` afterwards (without `--only-missing`:
every route between moved zones needs refreshing).

## Production order

`migrate → places:seed → zones:realign → routes:precompute`, each safe to
repeat. From the repo root, with `PROD_URL` exported in this shell only:

```bash
# 1. Migrations (status first: it lists what will be applied)
cd apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npx prisma migrate status
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npx prisma migrate deploy
cd ../..

# 2. Places
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run places:seed --workspace apps/server -- --dry-run
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run places:seed --workspace apps/server

# 3. Zones
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run zones:realign --workspace apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run zones:realign --workspace apps/server -- --apply

# 4. Zone routes (~4 minutes; no dry run — it only writes ZoneRoute rows)
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run routes:precompute --workspace apps/server -- --provider osrm
```
