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

Campus only, since 2026-10-29: the University of Ghana (Legon) campus **west
of J.J. Rawlings Avenue**. The Avenue (30 m either side of its westernmost
carriageway, ramps included) and everything east of it are not served, and
neither are the Main and Stadium gates' approach roads: drivers never pass a
gate. Off-campus service (Accra Mall and the like) is a future feature.

- **Source**: [assets/map/service-area.geojson](../assets/map/service-area.geojson),
  one polygon. Edit it at <https://geojson.io> (open the file, move points,
  save it back), then run `node scripts/map/service-area.mjs`. That writes
  [packages/shared/src/geo/serviceAreaPolygon.ts](../packages/shared/src/geo/serviceAreaPolygon.ts),
  which everything uses. `node scripts/map/service-area.mjs --from-osm`
  rebuilds the GeoJSON from OpenStreetMap (campus way 308668766, no buffer,
  the Avenue cut out) and **replaces hand edits**.
- **Tests** ([serviceArea.test.ts](../packages/shared/src/geo/serviceArea.test.ts))
  check that every gate's inside point is in the area, that no point of the
  Avenue (or any trunk road) is in it or within 25 m, and that the generated
  file matches the GeoJSON.
- **Who checks it**: the server refuses pickups and drop-offs outside it
  (`422 OUTSIDE_SERVICE_AREA`, with a sentence the app shows as-is). The rider
  app blocks pins outside it ("Outside campus") on the map, when dragging a
  pin and for home GPS. A driver outside it can't go online and gets no zone,
  so no requests: the app checks, and since 2026-10-29 the **server** checks
  the position the app sends ([services/zones/driverPosition.ts](../apps/server/src/services/zones/driverPosition.ts)):
  - going online off campus: `403 OUTSIDE_SERVICE_AREA`, unless the driver is
    on a trip (it keeps working, with no zone, so no new requests);
  - a zone update off campus clears the zone; the request list is empty for
    an off-campus position;
  - the last position while online is kept on `Driver` (`lastLat`, `lastLng`,
    `lastSeenAt`), for the admin live map;
  - apps from before 2026-10-29 send no position and keep the old behaviour;
    review demo drivers are exempt.
- **Where the apps get it**: built into the apps, the admin site and the
  server (`@rida/shared`), so a change reaches the apps with an update (OTA)
  and the server with a deploy. `GET /service-area` serves the server's copy
  to other clients; the apps don't call it.

### Gates

`CAMPUS_GATES` in [packages/shared/src/places/campusGates.ts](../packages/shared/src/places/campusGates.ts).
A gate is only a pickup and drop-off point, on its **inside**, on a campus road
where a car can stop and turn; drivers never pass one. Each is a place (by
`source`), with its OSM barrier nodes:

| Place | Inside point | Notes |
|---|---|---|
| Main Gate (inside) | [5.6503, -0.18139](https://www.google.com/maps?q=5.6503,-0.18139) | Closed to cars. On La Road behind the gate. Shown with "Cars can't pass the main gate". |
| Stadium Gate | [5.640669, -0.18105](https://www.google.com/maps?q=5.640669,-0.18105) | Was "Okponglo Gate" (same `source`, same id). On Jubilee Drive behind the security post's lift gate. |
| TF Gate | [5.66485, -0.18256](https://www.google.com/maps?q=5.66485,-0.18256) | South of the gate's lift barriers. In OSM, TF Hall is on the other side of this gate; the area still includes it. |

To put an existing database's places right (gates moved inside, every other
place outside the area deactivated; a dry run unless `--apply`):

```bash
npm run places:campus --workspace apps/server            # what would change
npm run places:campus:dev --workspace apps/server -- --apply
```

Production: see [Production order](#production-order).

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
nothing. Re-run `routes:precompute -- --apply` afterwards: every route
between moved zones needs refreshing.

## Production order

`migrate → places:seed → zones:realign → places:campus → routes:precompute → routes:clear-point-cache → zones:check`,
each safe to repeat. Run the migrations **before** deploying a server that
needs them (the Driver position columns: the server reads them). From the repo root, with `PROD_URL` exported in this
shell only (check its host first: `node -e 'console.log(new URL(process.env.PROD_URL).hostname)'`
prints the host and nothing secret; production is `ep-empty-violet-bay5yr3y…`):

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

# 3b. Campus only: gates inside, places outside the area deactivated (dry run first)
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run places:campus --workspace apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run places:campus --workspace apps/server -- --apply

# 4. Zone routes from the campus route engine (seconds; dry run first). Only
#    after the server with the engine is deployed. Writes only ZoneRoute.
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run routes:precompute --workspace apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run routes:precompute --workspace apps/server -- --apply

# 4b. Empty PointRoute: routes kept from the public OSRM server, unused since
#     the campus engine (dry run first; deletes only PointRoute rows)
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run routes:clear-point-cache --workspace apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run routes:clear-point-cache --workspace apps/server -- --apply

# 5. Zone neighbours: compare with the suggested ones (read-only). To apply
#    them, use the admin site (Places → Zone neighbours → Use the suggested
#    neighbours → Save), or a dry run and --apply here (it replaces hand edits)
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run zones:check --workspace apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run zones:link --workspace apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run zones:link --workspace apps/server -- --apply
```

### Zone neighbours (adjacency)

Dispatch offers a ride to online drivers in the pickup zone **and the zones
next to it** (ZoneAdjacency, read in either direction; rows touching a retired
zone don't count). Until 2026-11-24 every zone was next to every other (a full
mesh, 210 rows), so every request went to every online driver on campus.

**Fallback:** when no live driver with no trip is in the pickup zone or its
neighbours (none there, only stale or busy ones, or they declined it), the
request goes to every live driver on campus with no trip instead, and shows in
their "Requests near you" too. Drivers who declined it never get it again.

Now they are **real neighbours**, suggested from where the zones are
([zoneNeighbours.ts](../packages/shared/src/geo/zoneNeighbours.ts)): a zone's
area is every spot on campus nearer its centre than any other's, and two zones
are neighbours when those areas share at least 150 m of border, or their
centres are within 800 m. For the 14 zones in service that is 40 pairs (80
rows). Admins can change them (admin site, Places → Zone neighbours; every zone
must keep one neighbour; audit-logged `zones.neighbours`). `prisma/seed.ts`
applies the suggestion.

- `zones:check` only reads, inside a READ ONLY transaction. It prints the
  zones in service, the pairs linked now, the suggested pairs with their
  distances, what differs, rows linked one way only, and any zone with no
  neighbours.
- `zones:link` lists what it would add and remove; with `--apply` it makes the
  pairs exactly the suggested ones in one transaction (both directions; rows
  with a retired zone left alone). A second run changes nothing.

### Far-trip pricing

Campus has two far ends, kept in `Place.farEnd` (admin site, Places → Far-trip
pricing; each place North, South or none):

- **North**: Pentagon (every block, the food court), TF Hall (James Topp Nelson
  Yankah Hall), Bani Hostel, Evandy Hostel, and the hostels right beside them:
  Nairobi, Kampala, Dar es Salaam and Addis Ababa Courts.
- **South (Diaspora)**: Jean Nelson Aka, Elizabeth Frances Sey, Dr. Hilla Limann
  and Alexander Kwapong Halls, and what is right beside them inside the
  complex: Elizabeth Sey Pharmacy, Games Arena, Bervels, Tickels Restaurant.

A Shared seat costs the far price (GH₵9 to start) **only** on a trip from one
end to the other, either way. Every other Shared trip is the normal price
(GH₵7): main campus to or from either end, inside one end, main campus to main
campus. Ride alone is GH₵15 everywhere. An end of a trip counts as the place
the rider chose, or else the nearest place within 250 m of the pin. The
migration `20261124180000_dispatch_far_pricing` set the list above by name, so
annexes and "Other spot near …" places of the named halls and hostels are
included too. A new place near them is in neither end until an admin sets it.

Both refuse a production host without `ALLOW_PRODUCTION_DB=1`, even with
`NODE_ENV=production`, and print the database host only — never the URL. Code:
[zoneAdjacency.ts](../apps/server/src/scripts/zoneAdjacency.ts).
