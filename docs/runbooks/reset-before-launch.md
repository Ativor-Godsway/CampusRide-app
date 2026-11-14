# Reset trips to zero before the public launch (one-off)

`apps/server/src/scripts/resetTestData.ts` with **`--trips-only`** deletes the
test trips and the money around them, so the apps and the admin site start
from zero on launch day. **It never deletes or changes an account.** Real
people are already signing up from the App Store: `--trips-only` is the only
mode to use.

**Deleted** (only rows from before the cutoff you give, never the review
demo's):

- every ride, with its seats (each rider's stops, pins and fare), offers to
  drivers, rejections, ratings, ride payments, SOS records and SOS tracking
  links;
- every commission owed, payment, waiver, adjustment and Paystack payment
  attempt (Finances back to zero);
- driver online sessions and location trails.

**Untouched:** every account (riders, drivers, admins) and its profile,
driver approval and car, photos (Cloudinary isn't used at all), emergency
contacts, early access, sign-ins and push tokens, settings, zones, places,
notification history, the audit log, and the review demo accounts with all
their rides.

Nothing on an account is worked out from rides and stored: ride counts,
rating averages, earnings, commission balances and online hours are computed
from the rows above each time they're shown. With those rows gone, every
rider and driver reads as brand new, so no account field needs resetting
(the script prints `Users deleted: 0, users modified: 0`).

It's a **dry run unless you add `--confirm=RESET-TRIPS`**. The real run is
one database transaction: all of it happens, or none of it. It also adds one
`data.reset.trips` entry to the audit log.

> The old full reset (`--delete-accounts`, confirm word `RESET-CAMPUSRIDE`)
> also deletes accounts. Don't use it now. It refuses to run unless you name
> it, and `RESET-TRIPS` doesn't confirm it.

## Before you start

1. **Take a Neon backup branch** (`backup-YYYY-MM-DD`,
   [backup-and-restore.md](backup-and-restore.md#every-week-make-a-backup-branch-5-minutes)).
   This is the only way back.
2. In a terminal on your Mac, from the repository folder, set the database
   URL for this terminal only (copy it from Render → `campusride-server` →
   Environment → `DIRECT_URL`; never paste it into a file or a chat):

   ```bash
   export PROD_URL='<DIRECT_URL from Render>'
   ```

   Use the **direct** URL (no `-pooler` in the host): one long transaction
   is better on a direct connection. No Cloudinary settings are needed.
3. Pick the cutoff: an ISO time that has passed, e.g. the moment you start,
   `2026-11-16T12:00:00Z`. Trips and money rows from before it are deleted;
   anything after it stays.

## 1. Dry run

```bash
cd apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
npm run reset:test-data -- --trips-only --before=2026-11-16T12:00:00Z
```

Check, in what it prints:

- the first line: `Database endpoint: ep-empty-violet-bay5yr3y  ← PRODUCTION`
- `Mode: --trips-only` and `DRY RUN — nothing is written`
- **Rows deleted**: the numbers look like your test data
- `Users deleted: 0, users modified: 0`, and the number of accounts
- a **Note** about rides still open, if any: those are trips not yet
  completed or cancelled; they disappear from the apps too. If one could be
  a real trip happening now, pick an earlier cutoff.

Nothing is written by a dry run. Run it as often as you like.

## 2. Real run

The same command with `--confirm=RESET-TRIPS` at the end:

```bash
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
npm run reset:test-data -- --trips-only --before=2026-11-16T12:00:00Z --confirm=RESET-TRIPS
```

It prints the same counts and ends with `Database: committed.` If it stops
with an error before that, nothing in the database changed.

Then:

1. **Restart the server:** Render → `campusride-server` → Manual Deploy →
   **Restart service**. This clears what it keeps in memory (rate limits,
   driver positions, cached admin figures).
2. In the terminal: `unset PROD_URL`.

## 3. Check it in the admin site

1. **Overview:** rides at 0 (or only what came after the cutoff). Riders and
   drivers are the same numbers as before.
2. **Riders** and **Drivers:** everyone is still there, with no trips,
   ratings or earnings. Approved drivers are still approved, photos intact.
3. **Finances:** nothing owed, nothing paid, no Paystack payments.
4. **Safety:** no SOS records.
5. **Settings → Audit log:** a `data.reset.trips` entry by
   `script:resetTestData` with the cutoff and the counts. Launch mode and the
   commission rules are unchanged.
6. On a phone: a rider and a driver account still sign in, and the review
   demo numbers still work, with their demo trips.

## If it went wrong

Switch the server to the backup branch you took first
([backup-and-restore.md](backup-and-restore.md#b-older-than-6-hours-switch-the-server-to-a-backup-branch)),
or rewind production in Neon if it's within 6 hours
([A. rewind](backup-and-restore.md#a-within-the-last-6-hours-rewind-production-in-place)).
