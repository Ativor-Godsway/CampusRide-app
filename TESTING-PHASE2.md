# Testing Phase 2: the request board and the 7-minute window

This runs everything on your Mac against **phase2-test**, a copy of production
made on 25 Nov 2026 (Neon branch `phase2-test`, endpoint `ep-tiny-bread-bazvjtbb`).
Production is not touched, and nothing is merged.

- The copy holds real riders' and drivers' phone numbers and push tokens, so the
  local server runs with **texts, push notifications and payments switched off**.
  Login codes appear in the server's terminal instead of by SMS.
- Its address is only in `apps/server/.env.phase2-test`. That file is gitignored, so
  never commit it or paste it anywhere.
- Every Phase 2 command refuses to run against the production database
  (`ep-empty-violet-bay5yr3y`) or any database other than phase2-test.
- The fake riders use numbers that can't exist (+233099…) and names ending in
  "(test)". The cleanup step removes only those.

You need **three Terminal windows**: the server, the driver app, and the fake riders.

---

## Step 1: Get the branch (Terminal 1)

Go to the project:

```bash
cd ~/Desktop/CampusRideApp
```

Fetch the latest branches:

```bash
git fetch
```

Switch to the Phase 2 branch. This doesn't merge anything:

```bash
git checkout driver-request-board
```

Rebuild the database client for this branch:

```bash
npm run db:generate --workspace apps/server
```

Make sure the test copy has this branch's database changes. They're already
applied, so this should say there's nothing to do:

```bash
npm run db:migrate:phase2 --workspace apps/server
```

## Step 2: Start the server against the test copy (Terminal 1)

```bash
npm run dev:phase2 --workspace apps/server
```

Wait for a line saying `phase2:guard OK — phase2-test branch`, then
`Server listening at http://…:3000`. Leave this window open: login codes appear here.

## Step 3: Find your Mac's Wi-Fi address (Terminal 2)

Skip this step if you're using the iPhone simulator on the Mac.

Go to the project:

```bash
cd ~/Desktop/CampusRideApp
```

Print the address:

```bash
ipconfig getifaddr en0
```

It prints something like `10.107.10.227`. On your phone (same Wi-Fi), open
`http://10.107.10.227:3000/health` in the browser, using your own number. You should
see `{"status":"ok","app":"CampusRide"}`. If the Mac asks whether to allow incoming
connections for `node`, click **Allow**.

## Step 4: Point the driver app at the Mac (Terminal 2)

**On your phone:** write the Mac's address into the driver app's local settings:

```bash
echo "EXPO_PUBLIC_API_URL=http://$(ipconfig getifaddr en0):3000" > apps/driver/.env.development.local
```

**Or on the iPhone simulator:** use this instead:

```bash
echo "EXPO_PUBLIC_API_URL=http://localhost:3000" > apps/driver/.env.development.local
```

Start the driver app with a fresh bundle, so it picks up the address:

```bash
npm run dev:driver -- --clear
```

Open the CampusRide Driver **development build** on your phone, or press `i` in this
window for the iPhone simulator. This window should print
`[CampusRide] API server: http://…:3000`. If it says `api.campusride.app`, stop
it (Ctrl+C) and run the last two commands again.

## Step 5: Sign in as a driver

Your own driver account is in the copy, so use it.

1. In the app, sign in with **your own driver phone number**.
2. **No SMS is sent.** In **Terminal 1** (the server), find the line containing
   `DummyOtpService: OTP issued (dev only, code shown)` and type its `code` into
   the app.
3. **Not on campus at 5 AM?** Open the **Account** tab, find
   **DEVELOPER · FAKE LOCATION**, and pick a zone, for example *Pentagon Hostel*.
   The app now pretends to be there.
4. On **Home**, tap **Go online**.

If the copy says you owe commission and can't go online, use another approved driver
account you control, or tell me.

## Step 6: Fill the board with fake riders (Terminal 3)

Go to the project:

```bash
cd ~/Desktop/CampusRideApp
```

Start 12 fake requests over 4 minutes at Pentagon, JQB, Jean Nelson, Bani, Balme
and TF. `--open-now` opens CampusRide on the test copy, since 5 AM is outside
service hours:

```bash
npm run simulate:requests --workspace apps/server -- --count 12 --minutes 4 --open-now
```

Each request prints a line as it's made, for example
`✓ Ama (test)  Shared  GH₵7  Pentagon Block A → James Quartey Building`.
North ↔ South trips (Pentagon, TF or Bani ↔ Jean Nelson) show **GH₵9**.

To run another batch, clean up first (Step 8). Each fake rider can only have
one open request at a time.

## Step 7: Test the board (in the app)

1. **Pop-ups unchanged:** a request near you still pops up on Home for about
   20 seconds.
2. Open the new **Requests** tab. Every waiting request on campus is there,
   nearest first, and new ones appear without refreshing.
3. **Filters:** tap a pickup chip, for example "Pentagon Block A (2)". Drop-off
   chips for those requests appear, and tapping one narrows the list again.
   "All" resets.
4. **Cards:** each shows pickup → drop-off, Shared or Ride alone and its seats,
   the fare (GH₵7, GH₵9 or GH₵15), how long the rider has waited, and the
   distance from you.
5. **Several at once:** tick two or three Shared requests and tap
   **Add to my trip**. The trip opens with all of them. Then:
   - try ticking more than 4 riders: the bar says a car takes at most 4;
   - try a Ride alone request together with others: the bar says it must be taken
     on its own.
6. **During a trip:** go back to **Requests**. A line at the top shows your free
   seats. Requests that don't fit are greyed out with the reason, for example
   "Your car is full" or "Ride alone: needs an empty car". Filter to one pickup
   and add someone who fits.
7. **Already taken:** this needs a second driver phone signed in to the same Mac.
   Both tick the same request, one taps first. The other sees "1 was already
   taken" and the rest still go in.
8. **7 minutes:** leave one request alone. It stays on the board for 7 minutes,
   then disappears (the rider is told no driver was found).

## Step 8: Clean up (Terminal 3)

Remove every fake rider and their rides from the test copy:

```bash
npm run simulate:requests:cleanup --workspace apps/server
```

Stop the server and the app with **Ctrl+C** in Terminals 1 and 2.

Point the driver app back at production for normal use:

```bash
rm apps/driver/.env.development.local
```

## Afterwards

The phase2-test branch keeps costing a little Neon compute while it exists. When
you're done testing, delete it in the Neon console (project `withered-voice-05688596`,
branch `phase2-test`). Delete only **phase2-test**, never `production`.
