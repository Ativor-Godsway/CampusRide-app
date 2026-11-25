# Testing the request board on production

Two PRs go to production. This branch, `prod-board-test`, is never merged: it only
holds the test scripts and this guide.

- `driver-request-board`: the board, the 7-minute window, migration `20261125120000_request_board`.
- `prod-test-rides`: four small server changes that keep test requests away from every
  real driver (stacked on the first PR).

How the test stays away from real people:

- **Test riders** use numbers that can't exist (+233099…) and names ending "(test)",
  and every request carries the note "TEST RIDE (not a real rider)". They're flagged
  as review-demo riders, so they can book before service hours **without** opening
  CampusRide, and no real driver is ever offered them.
- **Your driver account (054 860 8146)** is flagged review-demo too, for the test
  only. Review-demo requests go only to review-demo drivers, so only you see them.
  While the flag is on you get **no real requests**. `prodtest:cleanup` removes it.
- **When it can run:** the script refuses to start while CampusRide is open, while
  you have a trip, or while the App Store demo driver is online.
- **Nothing leaves the system:** no texts, pushes or payments go to the test riders.
  No commission is owed, and none of it counts in admin numbers or refused-booking
  logs. Cleanup deletes all of it.

Do this **before service hours** (before 08:00).

---

## 1. Run the migration on production

Go to the project:

```bash
cd ~/Desktop/CampusRideApp
```

Get the board branch:

```bash
git fetch
```

```bash
git switch driver-request-board
```

```bash
git pull
```

Type the production database URL without it showing on screen or going into your
shell history. Paste the DIRECT_URL from Render, then press Enter:

```bash
read -rs PROD_URL
```

```bash
export PROD_URL
```

Apply the migration:

```bash
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run db:migrate --workspace apps/server
```

It should say `Applying migration 20261125120000_request_board`, then
`All migrations have been successfully applied`.

## 2. Merge

1. Open the PR for **driver-request-board** (create it from
   https://github.com/Ativor-Godsway/CampusRide-app/pull/new/driver-request-board
   if it doesn't exist). Wait for the three checks, then merge.
2. Then open the PR for **prod-test-rides**
   (https://github.com/Ativor-Godsway/CampusRide-app/pull/new/prod-test-rides).
   After the first merge it shows only its own commit. Wait for the checks, then merge.

Don't open a PR for `prod-board-test`.

## 3. Check the deploys

Render deploys `main` by itself. Wait until both deploys are **Live** in Render
(a few minutes after the second merge).

The server is up:

```bash
curl -s https://api.campusride.app/health
```

It should print `{"status":"ok","app":"CampusRide"}`.

The new server is running (the board exists). It should print `401` (it needs a
login), not `404`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.campusride.app/driver/requests/board
```

On the admin site: **Settings** shows a **Ride requests** card ("Search for 7
minutes"), and **About this system → Server version** shows the second merge's
commit.

## 4. Publish the OTAs

The release script only publishes production from an up-to-date `main`:

```bash
git switch main
```

```bash
git pull
```

Driver app:

```bash
bash scripts/eas-update.sh driver production "Request board tab, 7-minute search"
```

Rider app:

```bash
bash scripts/eas-update.sh rider production "Still looking for a driver, 7-minute search"
```

Each prints two update group IDs (iOS, then Android). Keep them in case you roll back.

On your iPhone: **fully close** CampusRide Driver, open it, wait about 10 seconds,
then fully close and open it again. The tabs now read
**Home · Requests · Earnings · Account**.

## 5. Run the test requests

Switch to the test-scripts branch:

```bash
git switch prod-board-test
```

```bash
git pull
```

```bash
npm run db:generate --workspace apps/server
```

Make 8 test requests over 3 minutes at Pentagon, JQB, Jean Nelson, Bani, Balme
and TF:

```bash
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run prodtest:requests --workspace apps/server -- --count 8 --minutes 3
```

It prints `TEST MODE ON` for your account, then one line per request, for example
`✓ Ama (test)  Shared  GH₵9  Pentagon Block A → Jean Nelson Aka Hall`.
If it refuses, it says why: CampusRide open, a trip under way, or the App Store
demo driver online.

## 6. Test (on your iPhone)

1. In CampusRide Driver, **go online**. In test mode your position is shown on
   campus, wherever you are.
2. **Pop-ups:** a test request pops up for about 20 seconds as before.
3. Open **Requests**. All the test requests are listed, nearest first, each with
   pickup → drop-off, seats, fare (GH₵7, GH₵9 North ↔ South, or GH₵15 alone),
   waiting time and distance.
4. **Filters:** tap a pickup chip ("Pentagon Block A (2)"), then a drop-off chip.
   "All" resets.
5. **Several at once:** tick two or three Shared requests and tap
   **Add to my trip**. The trip opens with all of them. Ticking more than 4 riders,
   or a Ride alone request with others, is refused with a reason.
6. **During the trip:** open **Requests** again. Requests that don't fit are
   greyed with the reason. Add one that fits.
7. **Finish the trip** in the app as usual (arrive, pick up, drop off), or leave
   it: cleanup removes it either way.
8. **7 minutes:** a request you leave alone stays on the board for 7 minutes, then
   disappears.

The pickup note on each test request says "TEST RIDE (not a real rider)".

## 7. Clean up

Delete every test rider, ride, seat and offer, and put your account back to
normal. It prints the counts:

```bash
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" npm run prodtest:cleanup --workspace apps/server
```

It should end with `back to normal (not test mode), offline … no trip`. Running it
twice is safe.

Forget the production URL in this terminal:

```bash
unset PROD_URL
```

```bash
git switch main
```

On your iPhone, fully close CampusRide Driver and open it again, then go online
when you're ready to drive. Real requests reach you again.

---

## Rollback: if the new Requests tab breaks the app

This republishes the production updates that were live before this release.
Phones pick them up on the next two launches. The server can stay as it is.

The update groups that were live before this release:

| App | Platform | Group |
|---|---|---|
| Driver | iOS | `8425e9ba-bf85-4dc0-915b-c94d39f9a4fc` |
| Driver | Android | `bf88cac6-f509-48fd-bb69-3b76fe356b9c` |
| Rider | iOS | `59e228da-b33e-4ddf-a9c5-a9e65d7c4155` |
| Rider | Android | `045ee9a6-16ca-437d-81b6-80a8ad62187f` |

Go to the driver app:

```bash
cd ~/Desktop/CampusRideApp/apps/driver
```

```bash
npx -y eas-cli@24 update:republish --group 8425e9ba-bf85-4dc0-915b-c94d39f9a4fc --destination-channel production -m "Roll back: request board"
```

```bash
npx -y eas-cli@24 update:republish --group bf88cac6-f509-48fd-bb69-3b76fe356b9c --destination-channel production -m "Roll back: request board"
```

Only if the rider app is broken too, go to the rider app:

```bash
cd ~/Desktop/CampusRideApp/apps/rider
```

```bash
npx -y eas-cli@24 update:republish --group 59e228da-b33e-4ddf-a9c5-a9e65d7c4155 --destination-channel production -m "Roll back: searching screen"
```

```bash
npx -y eas-cli@24 update:republish --group 045ee9a6-16ca-437d-81b6-80a8ad62187f --destination-channel production -m "Roll back: searching screen"
```

Check what's live now:

```bash
npx -y eas-cli@24 update:list --branch production
```

The top entries should be the "Roll back" ones.
