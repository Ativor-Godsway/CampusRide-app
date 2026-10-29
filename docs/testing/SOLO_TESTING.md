# Testing CampusRide with one phone

This guide is for testing the **driver app** with a steady stream of ride
requests when you only have one phone. It also covers testing the **rider app**
on its own.

The idea: your Mac runs the CampusRide server, connected to the **dev database**.
Your phone runs the driver app and talks to that server. A second program, the
**simulator**, plays about ten fake riders ("Test Ama", "Test Kofi"…). They keep
requesting rides near you, so you can accept, fill shared cars, pick up and drop
off.

```
   your phone (driver app) ──Wi-Fi──▶ server on your Mac ◀── simulator (fake riders)
                                             │
                                             ▼
                                   dev database (Neon, ep-flat-rain)
```

Nothing here touches production. The simulator refuses to run against the
production database, and nothing can switch that off. See
[What can't go wrong](#what-cant-go-wrong).

Run every command from the **repo root** (`CampusRideApp/`) unless a step says
otherwise. You'll use **three Terminal windows**: server, simulator, and the
Expo app.

> **On a phone hotspot? Use local Postgres.** The dev database is in the US.
> From a Mac on a phone hotspot, one database round trip measured about
> **1.4 seconds** (2026-10-01), and every driver action needs several. Actions
> still work (they're instant on the phone and retried in the background), but
> they take seconds to confirm and the simulator crawls. A database on your
> Mac answers in about a millisecond. See
> [Faster: use local Postgres](#faster-use-local-postgres) — it replaces Step 1
> and changes how you start the server and simulator.

---

## Step 0 — One-time setup

```bash
git checkout main && git pull
npm install
npm run build:shared
```

`build:shared` compiles the shared code the apps use. Run it again whenever you
pull new changes.

Check `apps/server/.env.development` (it exists already) has these lines:

```
OTP_PROVIDER="dummy"          # login codes appear in the server terminal, no SMS is sent
MOOLRE_SMS_ENABLED=false
ENABLE_MOCK_DRIVER=false      # must be false for driver testing — see the rider section
```

## Step 1 — Bring the dev database up to date

The dev database was missing columns because it was behind on migrations
(checked on 2026-09-30: **7 behind**). See what's missing:

```bash
npm run db:status:dev
```

Apply them:

```bash
npm run db:deploy:dev
```

It prints `[dev db guard] OK` and then `All migrations have been successfully
applied.` Run `db:status:dev` again and it should say `Database schema is up to
date!`. Do this again whenever someone adds a migration.

> This only ever runs against the dev database or local Postgres. It refuses
> production.

Then the campus places, the real zone positions and their roads (each safe to
repeat; see [docs/places.md](../places.md)):

```bash
npm run places:seed:dev --workspace apps/server
npm run zones:realign:dev --workspace apps/server -- --apply
npm run routes:precompute:dev --workspace apps/server -- --apply   # a few seconds
```

With places in the database the simulator's riders book **real campus places
with exact pins** (sometimes nudged or dropped near a place, sometimes with a
note for the driver). Without them it falls back to zones, like old app builds.

## Step 2 — Start the server on your Mac

**Terminal 1:**

```bash
npm run dev:server
```

Wait for a line like `Server listening at http://0.0.0.0:3000` and then
`Database connected`. **Leave this window open.** Login codes and errors show
up here. It restarts by itself when code changes.

Quick check in your Mac's browser: open <http://localhost:3000/health>. You
should see `{"status":"ok","app":"CampusRide"}`.

## Step 3 — Find your Mac's Wi-Fi address

```bash
ipconfig getifaddr en0
```

It prints something like `192.168.1.23`. That's your Mac's address on the Wi-Fi.
If it prints nothing, try `ipconfig getifaddr en1`.

**Your phone and your Mac must be on the same Wi-Fi network.** Mobile data won't
work, and neither will a network that isolates devices from each other (some
campus or guest networks). A phone hotspot with the Mac joined to it works.

Check from the **phone's browser**: open `http://192.168.1.23:3000/health`
(use your own number). You should see the same `{"status":"ok"…}`. If macOS
asks whether to allow incoming connections for `node`, click **Allow**.

## Step 4 — Point the driver app at your Mac

Create the file `apps/driver/.env.development.local` containing one line:

```
EXPO_PUBLIC_API_URL=http://192.168.1.23:3000
```

Or let Terminal write it for you, with your address filled in:

```bash
echo "EXPO_PUBLIC_API_URL=http://$(ipconfig getifaddr en0):3000" > apps/driver/.env.development.local
```

Then start the app. **Terminal 3:**

```bash
npm run dev:driver -- --clear
```

`--clear` matters: Expo bakes the server address into the app when it builds it,
so it needs a fresh build to notice the change. Open the app on your phone. The
Expo terminal prints:

```
[CampusRide] API server: http://192.168.1.23:3000
```

If it says `api.campusride.app`, the switch didn't take. Check the file name and run
with `--clear` again.

**Why this file and not `.env`?** Expo reads `.env.development.local` only while
you're running `expo start`. A real (release) build never reads it, so your
Mac's address can't end up in a build you ship. As a second lock, a release
build refuses any local or Wi-Fi address and uses production instead. The file
is git-ignored, so it's never committed either.

> Your Wi-Fi address can change (new network, router restart). If the app
> suddenly can't connect, redo Step 3 and rewrite the file.

## Step 5 — Your driver account on the dev database

The dev database is separate from production, so your production account
doesn't exist there. Sign up once:

1. In the driver app, sign up with your phone number.
2. **No SMS is sent.** The code appears in **Terminal 1** (the server), on a
   line containing `DummyOtpService: OTP issued (dev only, code shown)`, next
   to `code`. Type it into the app.
3. Fill in your driver profile (name, car make, model, colour, plate).
4. Approve yourself. There's no admin to do it on dev. In a spare terminal:

   ```bash
   npm run sim:approve-driver                    # lists drivers on the dev database
   npm run sim:approve-driver -- 0241234567      # approves yours (use your number)
   ```

5. In the app, tap **Go online**. Your zone is taken from your location.

You only do this once. After that, just sign in.

## Step 6 — Start the fake riders

**Terminal 2:**

```bash
npm run sim:riders
```

You'll see something like:

```
CampusRide fake-rider simulator  (local / development only)
  database: ep-flat-rain-apsyo6mp-pooler.c-7.us-east-1.aws.neon.tech
  server:   http://localhost:3000
  every 20s · max 4 open · 70% Shared · 15% give up

11:40:47  👥  10 fake riders ready (Ama, Kofi, Akosua, Kwame, …)
11:40:47  🚗  Godsway is online in Balme Library — requests will come from there and nearby
11:40:47  📍  Test Ama requested Shared (GH₵7), Balme Library → School of Business
11:40:51  ✅  Test Ama's request was accepted by Godsway
11:40:53  📍  Test Kwame requested Shared (GH₵7), Balme Library → School of Business  — going the same way as Test Ama
11:40:55  🤝  Test Kwame was added to Test Ama's shared car (driver Godsway)
11:40:57  📌  Driver is at Balme Library for Test Ama
11:41:00  🚕  Test Ama got in — heading to School of Business
11:41:03  🏁  Test Ama was dropped off at School of Business (GH₵7)
11:41:25  ✗  Test Kofi gave up waiting and cancelled — "Found another ride"
```

If it says **"Waiting for a driver to go online…"**, go online in the app. The
simulator aims requests at wherever you are.

### What you should see on the phone

- The request list on **Home** filling up (nearest first, live).
- **Accept** one: the trip screen opens at once (the server confirms in the
  background). It's the same screen for Ride alone and Shared:
  - a map with you, every stop numbered in order (green = pickup, black =
    drop-off) and the route;
  - the **NEXT STOP** card with **Navigate** and **Call**;
  - one slide at a time: **"Ama picked up"** at a pickup, **"Cash collected"**
    (amount shown large) at a drop-off;
  - **I'm here** if arriving wasn't detected automatically, and **Rider didn't
    show** three minutes after you arrived;
  - **N more stops** opens the ordered list; seat dots show who's on board.
- Every action changes the screen the moment you do it. If CampusRide is slow,
  a small **Sending…** chip appears at the top while it retries; you can carry
  on. If the server says no (say the rider cancelled), the screen goes back
  and a red line tells you why.
- **Filling a shared car:** about a third of Shared requests bring a second
  fake rider going the same way a few seconds later. Accept the first, then
  tap **Add rider** next to the seat dots (only before your first pickup).
- **Cancellations:** about 15% of fake riders give up if nobody accepts within
  20–60 seconds, with a reason. They never cancel after you've accepted, and
  never after pickup.
- **Nobody accepts in 90 seconds:** the fake rider decides, like a real one
  would. Keep waiting, switch Shared to Ride alone, or give up.
- The simulator never has more than 4 unaccepted requests open, so it doesn't
  flood you.
- Fake riders sometimes rate you after a trip.

### Options

Put options after `--`:

| Option               | What it does                                          | Default   |
| -------------------- | ----------------------------------------------------- | --------- |
| `--interval 10`      | seconds between new requests                          | 20        |
| `--max-open 6`       | most unaccepted requests at once                      | 4         |
| `--shared-ratio 0.5` | share of requests that are Shared (0 to 1)            | 0.7       |
| `--cancel-ratio 0`   | share of riders who give up waiting (0 turns it off)  | 0.15      |
| `--zone "Balme"`     | force pickups in a zone (part of its name is enough)  | your zone |
| `--burst 5`          | fire 5 requests at once when it starts (rapid offers) | off       |
| `--riders 15`        | number of fake riders (max 20)                        | 10        |

Examples:

```bash
npm run sim:riders -- --burst 5                  # five offers at once
npm run sim:riders -- --interval 8 --max-open 6  # busy afternoon
npm run sim:riders -- --shared-ratio 1           # Shared only, to practise filling cars
npm run sim:riders -- --zone "Akuafo"            # pickups at Akuafo Hall
```

## Step 7 — Stop the simulator

Press **Ctrl+C** in Terminal 2. The simulator:

- withdraws every request nobody has accepted yet, so they don't linger in your
  app;
- leaves any trip you've already accepted alone, so you can finish it in the app;
- prints a summary (requested, accepted, completed, gave up, expired).

Press Ctrl+C a second time only if it seems stuck.

## Step 8 — Clean up the fake riders

```bash
npm run sim:cleanup
```

This deletes the fake rider accounts and everything attached to them: their
rides, passenger rows, ratings, commission ledger rows, payments and login
tokens. It prints how many of each it removed.

It only touches accounts that are **all** of these at once: phone starting
`+233099`, name starting `Test `, and role rider. Your driver account, and any
other account, is never deleted. Only the records of the fake trips go.

Stop the simulator first. If you clean up while you're mid-trip with a fake
rider, that trip disappears from your app.

## Step 9 — Switch back to production

1. Delete the switch file:

   ```bash
   rm apps/driver/.env.development.local
   ```

2. Restart the app with a clean build: stop Expo (Ctrl+C in Terminal 3), then
   `npm run dev:driver -- --clear`.
3. Check the Expo terminal says `[CampusRide] API server:
https://api.campusride.app`.
4. Sign in again with your real account. Production and dev are separate
   databases with separate accounts.
5. Stop the local server (Ctrl+C in Terminal 1) if you're done.

---

## Testing the rider app with a fake driver (`sim:driver`)

A fake driver, **Kwame (test)**, that behaves exactly like the driver app
(real HTTP routes and the real socket): it goes online at a campus place,
accepts **your** newest ride request (never a `sim:riders` fake rider's),
drives the real road route to your exact pickup sending its position about
once a second, arrives, waits, picks you up, drives to your drop-off and
completes the trip. Development only: it refuses production and any
non-local server.

1. Server running (Step 2), `ENABLE_MOCK_DRIVER=false` (the server's own
   mock driver would grab your request first).
2. Point the **rider** app at your Mac (as in Step 4, with
   `apps/rider/.env.development.local`) and sign in as a rider.
3. In a second terminal:

   ```bash
   npm run sim:driver
   ```

   It prints "Online at Main Gate" and waits for a request.
4. In the rider app, plan a ride and request it (either type).
5. ✔ Within ~2 s: "Your driver is on the way" with Kwame, a white Toyota
   Corolla, GT 1234-26. The car moves along the road on your map towards
   your pickup pin, about once a second, and the ETA counts down.
6. ✔ At your pickup: "Your driver has arrived". After the wait: you're in
   the car, and the car drives to your drop-off.
7. ✔ At the drop-off: trip complete, fare, rating. The terminal says
   "trip complete" and Kwame goes offline. Run it again for another trip.

Options:

| Flag | What it does | Default |
|---|---|---|
| `--speed <km/h>` | how fast Kwame drives (5–120) | 30 |
| `--wait <sec>` | how long he waits at your pickup (0–300) | 10 |
| `--at <place>` | where he starts, e.g. `--at "Night Market"` | Main Gate |

Also try: cancel in the rider app while he's driving — ✔ the terminal says
"The ride was cancelled — stopping" and he goes offline. Ctrl+C at any time
also takes him offline.

Kwame is an approved driver account on the dev database (phone
+233099900001). `sim:cleanup` doesn't remove him: his finished trips are
part of your rider account's history.

## Testing the rider app on its own (mock driver)

For testing the rider app, the server can play a fake driver ("Kwame Mensah").
It accepts every ride about 4 seconds after it's requested, drives to the
pickup, picks the rider up and drives to the drop-off, sending live location
along the way. A trip takes about 30 seconds.

1. In `apps/server/.env.development`, set `ENABLE_MOCK_DRIVER=true`.
2. Restart the server (Ctrl+C in Terminal 1, then `npm run dev:server`).
3. Point the **rider** app at your Mac the same way as Step 4, using
   `apps/rider/.env.development.local`, and run `npm run dev:rider -- --clear`.
4. Sign up as a rider. The code is in the server terminal, as in Step 5.
5. Request a ride. Shared and Ride alone both work.

Good to know:

- There's one mock driver, and it drives one ride at a time. A second request
  waits its turn (it shows "Finding your driver…") until the first trip ends.
- If the server restarts mid-trip (it does whenever code changes), the mock
  driver finishes the interrupted trip the next time it's needed. It won't
  leave you stuck on a ride.
- **Turn it off again (`ENABLE_MOCK_DRIVER=false`) before driver testing.**
  Otherwise the mock driver grabs the fake riders' requests before you can. The
  simulator warns you if it sees that happen.
- Switch the rider app back to production the same way as Step 9, deleting
  `apps/rider/.env.development.local`.

---

## What can't go wrong

- **Production database.** The simulator, `sim:cleanup`, `sim:approve-driver`
  and `db:deploy:dev` only run against local Postgres or the dev database
  (`ep-flat-rain…`). Anything else, including production, is refused before a
  connection is opened. `ALLOW_PRODUCTION_DB=1` is ignored, and so is
  `ALLOW_TEST_DB_HOST`. They also refuse to run with `NODE_ENV=production`.
- **Production server.** The simulator only sends requests to a server on your
  Mac or your local network. It refuses the Render URL.
- **Real SMS.** Fake riders are written straight into the database and signed
  in with a token the simulator creates itself. They never go through OTP login
  or Moolre. Their numbers (`+233099…`) can't be real Ghanaian numbers anyway.
- **Shipping your Mac's address.** See Step 4. Release builds don't read the
  switch file and refuse local addresses.

## Testing from off-campus: fake location

Far from campus, distances say things like "122.2 km", ETAs are meaningless and
automatic arrival never fires. Development builds can pretend to be on campus:

1. Driver app → **Account** → **Developer · Fake location** → tap a zone, for
   example **Balme Library**. The app now behaves as if you're standing there:
   your zone on the server follows it (so the simulator sends requests near
   it), and distances and ETAs are measured from it.
2. Go online, accept a request. A yellow **Fake location** chip shows on the
   trip screen, with **▶ Drive (fake)**.
3. Tap **▶ Drive (fake)**: the app drives along the route to the next stop at
   about 30 km/h, ending on the rider's exact pin. When it stays within ~50 m
   of an exact pickup pin (~60 m of a zone centre, for a ride booked without
   one), **arrival is detected automatically** — the rider is told you're
   here and the wait timer starts.
4. Tap **Off (real GPS)** in Account to go back to your real position.

This is **impossible in a release build**: the code is behind React Native's
`__DEV__`, which is `false` in a release bundle, so it's stripped out and the
Account card doesn't exist.

## One-phone test script

With the server running (Step 2 — on local Postgres if you're on a hotspot, see
[Faster: use local Postgres](#faster-use-local-postgres)), the app pointed at
your Mac (Step 4) and signed in as your approved driver (Step 5).

**What "instant" means here:** every slide, tap and Add changes the screen the
moment you do it. The request goes to the server in the background. If the
server is slow, a small **Sending…** chip shows at the top — you carry on. If
the server says no, the screen goes back and a red line says why.

### A 3-rider shared trip, from Home

1. **Account → Fake location → Balme Library.** Back on **Home**, go online.
2. Start Shared riders near you:
   `npm run sim:riders -- --shared-ratio 1 --zone Balme --interval 15`
3. ✔ The request list fills on **Home**: type and seats, distance, pickup →
   drop-off, price, the rider's name and how long ago, nearest first. Try the
   **All / Shared / Private** chips and pull to refresh.
4. **Accept** the top one (say Ama). ✔ The trip screen opens at once with the
   full trip — map, numbered stops, "Pick up Ama at Balme Library" — no
   "Confirming…" step. Seat dots show "1 of 4"; the first time, a one-line
   legend explains them.
5. Tap **←**. ✔ Home shows the green banner at the top ("Filling your car ·
   1 rider · Tap to return to your trip") and, below it, only riders who fit
   your route, each with **See route** and **Add**.
6. **Add a rider from Home:** tap **Add** on one (say Kofi). ✔ Kofi leaves the
   list at once and the banner says 2 riders.
7. Tap the banner. ✔ The trip shows Kofi straight away in **N more stops**
   (named, not "Your rider").
8. **Add a rider from the trip screen:** tap **Add rider** → **See route** on a
   third rider (say Yaw). ✔ dotted route, **New** pins, "+1 rider · adds ~N
   min · +GH₵7". Tap **Add**. ✔ the dotted line turns solid, seat dots "3 of
   4", the stop list shows Yaw.
9. **▶ Drive (fake)** to the first pickup. ✔ About 10 seconds after stopping
   there, the card shows "Ama knows you're here · Waiting 0:05" on its own.
10. **Slide "Ama picked up".** ✔ The knob turns into a check mark with a buzz
    and the next stop moves up **in the same moment**; a toast says "Ama is
    in the car · next: pick up Kofi"; the seat dots fill one in.
11. Pick up Kofi and Yaw the same way (Drive, then slide). Each slide advances
    at once. Open **N more stops** — ✔ each rider has one word: Waiting /
    Arrived / In car.
12. Drive to each drop-off. The card says "Drop off Ama at … · collect GH₵7"
    with the amount large. **Slide "Cash collected from Ama"**. ✔ instant;
    toast "Ama dropped off · next: drop off Kofi"; the stop list has a
    **Done** section with Ama.
13. **The last drop-off:** slide it. ✔ Straight to **Trip complete** (cash
    collected, your share). **Back to Home** — ✔ no banner, the request list
    is back; no waiting for the server.

### A Ride-alone trip

14. Stop the simulator (Ctrl+C) and start private riders:
    `npm run sim:riders -- --shared-ratio 0 --zone Balme`
15. Accept one from Home. ✔ The trip opens at once.
16. Tap **←**. ✔ Home shows the banner and "You're on a Ride alone trip",
    no request list.
17. Drive, let it arrive, **slide "… picked up"**, drive, **slide "Cash
    collected …"**. ✔ each instant; the last one goes straight to Trip
    complete, then Home is free again.

### Exact pickup and drop-off pins

E1. Start riders: `npm run sim:riders -- --zone Balme --interval 20`. ✔ The
    simulator log shows places, e.g. `Cedi Conference Centre (pin moved) →
    Jubilee Hall  “Waiting at the bus stop”`.
E2. ✔ **Home** shows each request by **place name** ("Cedi Conference Centre
    → Jubilee Hall"), never coordinates. Accept one.
E3. ✔ The trip screen's map pin sits on the exact spot (zoom in: it's on the
    building or the moved pin, not at a zone centre); the card says "Pick up
    Kwame at Cedi Conference Centre"; a rider who left a note shows it in
    quotes under the instruction.
E4. ✔ The blue line follows campus roads to that pin ("© OpenStreetMap
    contributors" in the corner), never J.J. Rawlings Avenue or a closed gate.
    Until the route arrives, or if there's none, a dashed straight line shows.
E5. Tap **Navigate**. ✔ Google Maps opens with directions to the exact point
    (a pin, not a search for the name). Come back to the app.
E6. **▶ Drive (fake)**. ✔ The car follows the line and stops on the pin;
    about 10 s later the card says the rider knows you're here.
E7. **Add a rider** (Shared): ✔ the preview shows the new rider's pins at the
    named place, and their stop list entry by name.
E8. With the rider app on a second account (or Expo Go on the same phone):
    **Plan your ride** → ✔ pickup "Current location" (or "At Balme Library"
    under it when you're within ~50 m); type `balm librray` → ✔ Balme Library;
    **Choose on map** → move the map off campus → ✔ "outside the CampusRide
    area" and the button is off; back on campus → **Set drop-off here**.
E9. **Choose a ride** → **Move pin** → drag the green pin ✔ it can't go more
    than 200 m (a light circle shows how far); **Add a note for your driver**;
    request. ✔ The driver sees the moved pin and the note.

### Ride offer pop-ups

O1. Online and free on **Home**, start riders:
    `npm run sim:riders -- --zone Balme --interval 20`. ✔ Each new request
    **slides up as a card** with a buzz and a short chime (iPhone on silent:
    buzz only): fare large, Ride alone / Shared · seats, pickup → drop-off
    by name, "To pickup" and "Trip" minutes and distance, the rider's first
    name (and rating once drivers have rated them), a countdown ring from 15,
    a big **Accept** and a small **Decline**. No map pin, no note.
O2. **Queue:** stop it and run `npm run sim:riders -- --zone Balme --burst 4
    --interval 300`. ✔ One card at a time, nearest pickup first, "+3 more
    waiting"; each decline or timeout brings the next. The Home list behind
    still shows all of them.
O3. **Decline** one. ✔ The card closes; that request never pops up again
    (it disappears from your list too) — the simulator's other riders are
    unaffected.
O4. **Let one run out.** ✔ At 0 the card closes by itself and that request
    isn't offered to you again.
O5. **Accept.** ✔ The trip opens at once (no waiting). Finish or cancel it.
O6. **Withdrawn while showing:** with a card up, press **c** in the
    simulator terminal (the newest waiting rider cancels). ✔ If that was the
    card on screen it closes with "The rider cancelled"; if it was queued,
    "+N more" drops by one. Or run with `--cancel-after 8` to make every
    rider give up 8 s after requesting.
O7. **Taken by someone else:** there's no second driver on one phone, so
    this is covered by the server tests (two accepts at once: exactly one
    wins, the other gets "Ride taken by another driver"). On the phone, if
    an accept is refused, the trip screen says why and goes back to Home on
    its own after ~2 s.
O8. **Background:** with a card showing, switch to another app for 20 s and
    come back. ✔ No expired card is waiting; the next live one (if any) pops
    up. While the app is in the background **no offers are shown and no
    sound plays** — keep the app open while online (push notifications come
    with the Android pilot build).
O9. **Mid-trip offer (Shared):** accept a Shared request, then keep the
    simulator running with `--shared-ratio 1`. ✔ When a rider who fits your
    route appears (within the 5-minute detour limit, a free seat), a simple
    card appears above the NEXT STOP card: a thin bar along its top edge
    counting down, the pickup (green dot) and drop-off (square) by their
    FULL names, one big **Add**, and a small **✕** in the corner. The map
    shows the dotted route with the new pickup (green) and drop-off (black
    square) ringed in orange and tagged "New". The NEXT STOP card and slider
    stay visible. **Add** → the new stops join the stop list; **✕** or the
    bar running out → closes, never offered again.

### The end of a shared trip (fixed 2026-10-13)

T1. Accept a Shared rider, let a second one be added (or add one), then:
    pick up the first, pick up the second, drop off the first, drop off the
    second. ✔ After every slide the NEXT STOP card, the seat chip ("2 of 4",
    "1 of 4", …) and the route on the map move on at once.
T2. ✔ The last drop-off goes straight to **Trip complete** and STAYS there —
    it never jumps back to "Pick up … at <first rider's pickup>". Back to
    Home: no banner, and new offers pop up again.
T3. The simulator's riders now have different first names (Ama, Kofi,
    Akosua…, shown as "Ama (test)" in lists), so the stops say "Pick up Ama",
    "Drop off Kofi".

### Also check

18. **A rider cancels:** with a trip running, cancel from the simulator side
    (`npm run sim:riders -- --cancel-ratio 1` makes riders give up before
    you accept) — or let a request you were about to add expire. ✔ Home and
    the trip screen update within a second or two without leaving the screen.
19. **Leave and come back:** kill the app mid-trip and reopen it. ✔ you're
    back on the same trip.
20. **Off campus:** turn **Fake location** off far from campus and try to go
    online. ✔ "You're outside the CampusRide area".
21. Ctrl+C the simulator, then `npm run sim:cleanup`.

## Troubleshooting

| You see                                                         | Do this                                                                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Can't reach your local server at http://localhost:3000`        | Start it: `npm run dev:server` (Step 2).                                                                                                       |
| App shows network errors / can't sign in                        | Phone and Mac on the same Wi-Fi? Does `http://<mac-ip>:3000/health` open in the phone's browser? Did the IP change (Step 3)?                   |
| Expo terminal still shows `api.campusride.app`                  | Check the file is exactly `apps/driver/.env.development.local`, then `npm run dev:driver -- --clear`.                                          |
| `Waiting for a driver to go online…`                            | Go online in the driver app. Approved? `npm run sim:approve-driver`.                                                                           |
| `Driver account is not approved yet` in the app                 | `npm run sim:approve-driver -- <your number>`                                                                                                  |
| `The server rejected the simulator's sign-in (401)`             | The server was started some other way. Stop it and use `npm run dev:server`.                                                                   |
| `…running against a different database`                         | Same fix: restart the server with `npm run dev:server`.                                                                                        |
| Requests accepted by "Kwame" instead of you                     | `ENABLE_MOCK_DRIVER=false` in `apps/server/.env.development`, restart the server.                                                              |
| The app errors about a missing column                           | The dev database is behind: `npm run db:deploy:dev` (Step 1).                                                                                  |
| `REFUSING TO RUN against …`                                     | The database named isn't local or the dev branch. Check `apps/server/.env.development`. Never point it at production.                          |
| `sim:cleanup` says a simulator ride "also carries a real rider" | A real account shares a car with a fake one, so the script deleted nothing. Finish or cancel that ride, then run it again.                     |
| **Sending…** stays on the trip screen for a long time           | CampusRide is slow to answer (often the dev database over a hotspot). Your actions are kept and retried; switch to local Postgres for testing. |
| Distances like "122.2 km", no automatic arrival                 | You're off campus: use **Account → Fake location** (development builds only).                                                                  |

## Faster: use local Postgres

The dev database is in the US; over a phone hotspot every request takes
seconds. The app no longer waits on that (every step shows at once), but the
simulator and confirmations are much quicker on a database on your Mac.

**What's on this Mac:** Homebrew **PostgreSQL 16**, already running as a
service (the test suite uses it). If it's ever stopped:
`brew services start postgresql@16`.

**One-time setup** (from the repo root):

```bash
createdb -h localhost rida_dev
printf 'DATABASE_URL="postgresql://%s@localhost:5432/rida_dev"\nDIRECT_URL="postgresql://%s@localhost:5432/rida_dev"\n' "$(whoami)" "$(whoami)" > apps/server/.env.development.local
npm run db:deploy:dev                              # create the tables
npm run db:seed:dev --workspace apps/server        # the 15 campus zones
npm run routes:precompute:dev --workspace apps/server -- --apply   # optional: zone roads
```

That file, `apps/server/.env.development.local`, is the switch. While it
exists, **everything** uses your local database: `npm run dev:server`, the
simulator, `sim:cleanup`, `sim:approve-driver` and the `db:*:dev` commands — no
exports, nothing else to remember. It's git-ignored.

A local database starts empty: sign up your driver again (Step 5) and approve
it with `npm run sim:approve-driver -- <your number>`.

**Back to the US dev database:** `rm apps/server/.env.development.local`, then
restart the server and simulator.
