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

If it says `onrender.com`, the switch didn't take. Check the file name and run
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
11:40:47  📍  Test Ama requested Shared (GH₵5), Balme Library → School of Business
11:40:51  ✅  Test Ama's request was accepted by Godsway
11:40:53  📍  Test Kwame requested Shared (GH₵5), Balme Library → School of Business  — going the same way as Test Ama
11:40:55  🤝  Test Kwame was added to Test Ama's shared car (driver Godsway)
11:40:57  📌  Driver is at Balme Library for Test Ama
11:41:00  🚕  Test Ama got in — heading to School of Business
11:41:03  🏁  Test Ama was dropped off at School of Business (GH₵5)
11:41:25  ✗  Test Kofi gave up waiting and cancelled — "Found another ride"
```

If it says **"Waiting for a driver to go online…"**, go online in the app. The
simulator aims requests at wherever you are.

### What you should see on the phone

- The **Requests near you** list filling up.
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
https://campusride-server-aaum.onrender.com`.
4. Sign in again with your real account. Production and dev are separate
   databases with separate accounts.
5. Stop the local server (Ctrl+C in Terminal 1) if you're done.

---

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
   about 30 km/h. When it gets within ~60 m of a pickup, **arrival is detected
   automatically** — the rider is told you're here and the wait timer starts.
4. Tap **Off (real GPS)** in Account to go back to your real position.

This is **impossible in a release build**: the code is behind React Native's
`__DEV__`, which is `false` in a release bundle, so it's stripped out and the
Account card doesn't exist.

## One-phone test checklist

With the server running (Step 2), the app pointed at your Mac (Step 4), and
signed in as your approved driver (Step 5):

1. **Account → Fake location → Balme Library.** Go online.
2. Start riders, Shared only, near you:
   `npm run sim:riders -- --shared-ratio 1 --zone Balme --interval 15`
3. **Accept** a request from **Requests near you**. The trip screen opens at
   once. ✔ map, numbered stops, route; seat dots "1 of 4".
4. **Add a rider with a route preview.** A rider going your way is offered on
   the trip screen by itself (or tap **Add rider** → **See route**). ✔ the map
   shows your current route solid and the new one dotted and lighter, the new
   pins marked **New**, all stops in view, and a label like "+1 rider · adds
   ~2 min · +GH₵5". Tap **Skip** once — ✔ the preview disappears. On the next
   one tap **Add** — ✔ the dotted route turns solid, the stop list and seat
   dots update ("1 of 4"). Leave one alone for 90 seconds — ✔ it disappears
   when the request expires.
5. Tap **▶ Drive (fake)**. ✔ the dot moves along the route; near the pickup the
   car stops at the pickup and, about 10 seconds later, the card switches to
   "Ama knows you're here · Waiting 0:05" without you tapping **I'm here**.
   (Driving straight past a pickup never counts as arriving.) This works on
   any screen — go to the Rides tab while it drives and come back. The simulator logs "Driver is at … for Test Ama".
6. **Slide "Ama picked up".** ✔ the next stop moves up at once. While you
   drive, ✔ the route line only shows what's ahead of you.
   **Add a rider mid-trip:** with Ama in the car, a rider on the way is
   offered (or use **Add rider** → **See route**). ✔ the preview shows the
   extra minutes; **Add** works if it keeps Ama within 5 minutes of her
   drop-off, otherwise it says the detour is too long. (Riders already in
   the car get "Picking up 1 more rider on the way · ~N min" in the rider
   app.)
7. For the second rider, tap **I'm here** yourself, then wait 3 minutes. ✔
   **Rider didn't show** unlocks; use it. ✔ that stop leaves the list; the
   simulator logs the cancellation.
8. **▶ Drive (fake)** to the drop-off. **Slide "Cash collected"** (GH₵5 shown
   large). ✔ "Trip complete" with what you collected and your share.
9. Now Ride alone: `npm run sim:riders -- --shared-ratio 0 --zone Balme`.
   Accept one and run it start to finish the same way.
10. **Burst:** `npm run sim:riders -- --burst 5`. ✔ the list fills; accepting
    is instant every time.
11. **Leave and come back:** mid-trip, tap ← (Home says "You're on a trip");
    switch tabs (the green banner shows); kill the app and reopen it. ✔ every
    time you get back to the same trip.
12. **Off campus:** turn **Fake location** off and, far from campus, try to go
    online. ✔ "You're outside the CampusRide area". Turn it back on — ✔ you
    can go online again.
13. Ctrl+C the simulator, then `npm run sim:cleanup`.

## Troubleshooting

| You see                                                         | Do this                                                                                                                                        |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Can't reach your local server at http://localhost:3000`        | Start it: `npm run dev:server` (Step 2).                                                                                                       |
| App shows network errors / can't sign in                        | Phone and Mac on the same Wi-Fi? Does `http://<mac-ip>:3000/health` open in the phone's browser? Did the IP change (Step 3)?                   |
| Expo terminal still shows `onrender.com`                        | Check the file is exactly `apps/driver/.env.development.local`, then `npm run dev:driver -- --clear`.                                          |
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

A database on your Mac makes every action confirm in milliseconds instead of
seconds. You already have Postgres running (the test suite uses it). One-time
setup:

```bash
createdb -h localhost rida_dev
export DATABASE_URL="postgresql://$(whoami)@localhost:5432/rida_dev"
export DIRECT_URL="$DATABASE_URL"
npm run db:deploy:dev                              # create the tables
npm run db:seed:dev --workspace apps/server        # the 15 campus zones
```

Then, **every time**, export the same two lines in **both** the server's and the
simulator's terminal before starting them:

```bash
export DATABASE_URL="postgresql://$(whoami)@localhost:5432/rida_dev"
export DIRECT_URL="$DATABASE_URL"
npm run dev:server          # Terminal 1
npm run sim:riders          # Terminal 2 (after the same two exports)
```

A local database starts empty: sign up your driver again (Step 5) and approve
it with `npm run sim:approve-driver` in a terminal with the same exports. To
draw real roads instead of straight lines, see [docs/routing.md](../routing.md).
