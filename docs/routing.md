# Road routes on campus

Written for: whoever maintains routing, the campus road graph and the gates.

Since 2026-10-29 every road route CampusRide draws or times comes from **our
own campus route engine**, on our own server. The public OSRM server is no
longer used: it routed trips out through the Main Gate and along J.J.
Rawlings Avenue.

## How it works

- **The graph**: [assets/map/campus-roads.json](../assets/map/campus-roads.json),
  every drivable road **inside the service area**
  ([assets/map/service-area.geojson](../assets/map/service-area.geojson)), from
  OpenStreetMap. Built by `node scripts/map/campus-roads.mjs`. It holds no
  trunk road (J.J. Rawlings Avenue and its ramps are outside the area anyway),
  no footway, nothing tagged `access`/`motor_vehicle=no` or `private`, and no
  segment that leaves the area, even briefly. One-ways are kept as tagged:
  `oneway=yes`, `oneway=-1` (drawn backwards) and roundabouts.
- **The engine**: `CampusRouter` in
  [packages/shared/src/routing/campusRouter.ts](../packages/shared/src/routing/campusRouter.ts).
  Each point is **snapped** to the nearest drivable road of the **main road
  network** (within 300 m): the largest part of the graph where every road
  can be driven to and from every other. So a pin is never put on a road cut
  off from the rest (a compound behind a closed gate, a stub at the edge) or
  on a one-way dead end (like the loop at the Stadium Gate security post,
  whose way out was the gate). Then A* finds the **fastest** drive between
  the snapped points, respecting one-ways (a pin partway along a one-way
  road included). Every place in the place list routes to and from Balme
  Library; the farthest is snapped 108 m (Bush Canteen). Speeds by road
  class (`CAMPUS_ROAD_SPEEDS_KMH`): secondary 40 km/h, tertiary 35,
  unclassified 30, residential 25, service 20, parking aisles and driveways 10.
  A route takes a few milliseconds.
- **No route, no guess**: a point with no main-network road within 300 m
  (`NO_ROAD`) is refused with a plain sentence. Two snapped points can always
  be joined, so `NO_ROUTE` is only a safety net. The apps then draw a dashed
  straight line, as they always did while waiting.
- **The server**: [apps/server/src/services/routing/campusRoutes.ts](../apps/server/src/services/routing/campusRoutes.ts)
  builds the router once (about 10 ms) and keeps up to 1,000 recent routes in
  memory. Nothing is sent to anyone, and nothing is stored in the database.

## Gates

Drivers never pass a gate to the outside: those roads aren't in the graph.
Which barriers inside the area cars may pass is decided in
[assets/map/campus-gates.json](../assets/map/campus-gates.json):

- **Listed gates win.** The Main Gate (closed to cars) and the Stadium Gate
  are listed closed; the **TF gate is open**, so cars reach TF Hall (James
  Topp Nelson Yankah Hall). The road on from TF Hall to the main road is
  outside the service area, so no route continues there.
- **Any other barrier follows its OpenStreetMap tags**: closed if it's a
  bollard, block, chain or the like, or tagged `access`/`motor_vehicle=no` or
  `private`; open otherwise (an untagged gate, `access=yes`, `permissive`, or
  `permit` — the UG E-card lift gates).

The graph script prints every barrier inside the area with its decision and
a map link. To change one, add it to `campus-gates.json` by its OSM node id
and rebuild.

## Rebuilding the graph

After a change to the service area, the gates, or campus roads in
OpenStreetMap:

```bash
node scripts/map/campus-roads.mjs        # fetches OSM; or --osm-file saved.json
npm test --workspace packages/shared     # campusRouter.test.ts checks the rules
npm run routes:examples --workspace apps/server   # five routes with map links
```

Commit the new `assets/map/campus-roads.json`; deploying the server is what
puts it in use. Then regenerate the zone routes (below).

The tests check that every point of the graph is inside the service area,
that none is within 25 m of a trunk road, that no closed gate is in it (and
the TF gate is), that 200 random routes never take a one-way road the wrong
way, that every place routes to and from Balme Library, snapping (never to a
detached road or one-way dead end), the no-road refusal, and that a route
takes well under 100 ms.

## Zone routes (ZoneRoute)

A route for every ordered pair of zones in service (A→B and B→A apart:
one-way roads make them differ), stored in `ZoneRoute`. The shared-ride
**detour rule** (5 minutes) and the driver's trip planning use their times
zone to zone; old app builds draw them before an exact route arrives.

```bash
npm run routes:precompute --workspace apps/server              # dry run: what would be written
npm run routes:precompute:dev --workspace apps/server -- --apply   # dev database
```

With `--apply` it writes them all in one transaction (provider `campus`) and
removes the stored route of any pair the campus roads can't join (rather
than keep an old OSRM one). Re-run it after the zones or the graph change.
Production commands: [docs/places.md](places.md#production-order).

## What uses the engine, and what is still a straight line

| | Source |
|---|---|
| Every drawn route (`POST /routes/legs`): the rider's trip preview, the driver's way to the pickup and the trip's stops, ride offers | Campus engine |
| Ride offer "trip 6 min · 2.3 km" | Campus engine |
| Ride offer "pickup 3 min · 900 m" (driver → named pickup place) | Campus engine; straight line × 1.3 only when the driver is too far from any campus road |
| Detour rule and trip planning, zone to zone | Zone routes, from the campus engine once regenerated |
| The short bits between a pin and its zone centre inside those plans | Straight line × 1.3 (as before) |
| Rider's "driver is N min away" in the app | Straight line × 1.3, worked out in the app (changing it needs an app update) |
| "Driver almost there" push, automatic arrival, minimum trip length | Straight-line distance (they are about how near, not how long) |
| App Store review demo car | Campus engine |

## Response the apps get

`POST /routes/legs` answers as it always has: `polyline`, `distanceMeters`,
`durationSeconds`, `legs`, `source: "osrm"` and `attribution`
("© OpenStreetMap contributors"). `"osrm"` is kept as the wire value for "a
real road": apps already installed draw it solid. A refusal is `422` with
`{ error, code }` (`NO_ROAD`, `NO_ROUTE`, or `OUTSIDE_SERVICE_AREA` for a stop
outside the area).

Map data © OpenStreetMap contributors, under the Open Database Licence: every
map that draws a route shows the credit.
