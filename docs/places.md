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
the OSM campus boundary pushed out 200 m, plus the N4 corridor down to Accra
Mall (Okponglo, Shiashie, Tetteh Quarshie). Pickups and drop-offs outside
it are refused (`422 OUTSIDE_SERVICE_AREA`, with a sentence the app shows
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

### 1. Review the list

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
to re-fetch.

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
you removed from the CSV.

## Optional: put the zone centres where the places really are

The 15 zones were seeded with approximate centres packed into ~800 m. On
the map the same places spread over ~4.5 km; "Accra Mall Junction" is
~3.2 km from the real junction, "Sports Stadium" ~1.8 km from the stadium.
Nothing breaks, but "nearest zone to a pin" is only as good as the centres
(today Akuafo Hall's nearest zone is "Accra Mall Junction").

```bash
npm run zones:realign --workspace apps/server                   # dry run: what would move, and how far
npm run zones:realign:dev --workspace apps/server -- --apply     # dev
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
  npm run zones:realign --workspace apps/server -- --apply      # production
```

It moves zones by exact name (ids never change), recomputes every place's
zone, and tells you to re-run the zone routes (`routes:precompute`), which
were drawn between the old centres. Two positions are guesses, marked
CHECK in [scripts/realignZones.ts](../apps/server/src/scripts/realignZones.ts):
"Medical School (UGMS)" and the "Botanical Gardens Gate".
