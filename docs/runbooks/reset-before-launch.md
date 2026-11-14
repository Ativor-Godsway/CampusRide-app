# Reset to zero before the public launch (one-off)

`apps/server/src/scripts/resetTestData.ts` deletes every rider and driver
account created before a cutoff, every ride and trip record, and every
commission and payment row, so Finances starts at zero on launch day. What it
keeps and deletes, exactly, is at the top of the script.

**Kept:** admin accounts, the review demo accounts and their data, the numbers
you pass with `--keep`, accounts created at or after the cutoff, the admin
audit log, and every setting (launch mode, commission rules, prices, zones,
places).

It's a **dry run unless you add `--confirm=RESET-CAMPUSRIDE`**. The real run
is one database transaction: all of it happens, or none of it. Deleted
drivers' photos are removed from Cloudinary only after that, and any that
fail are listed.

## Before you start

1. **Take a Neon backup branch** (`backup-YYYY-MM-DD`,
   [backup-and-restore.md](backup-and-restore.md#every-week-make-a-backup-branch-5-minutes)).
   This is the only way back.
2. In a terminal on your Mac, from the repository folder, set these for
   this terminal only (copy each value from Render → `campusride-server` →
   Environment; never paste them into a file or a chat):

   ```bash
   export PROD_URL='<DIRECT_URL from Render>'
   export PROD_CLOUDINARY_CLOUD_NAME='<CLOUDINARY_CLOUD_NAME>'
   export PROD_CLOUDINARY_API_KEY='<CLOUDINARY_API_KEY>'
   export PROD_CLOUDINARY_API_SECRET='<CLOUDINARY_API_SECRET>'
   ```

   Use the **direct** URL (no `-pooler` in the host): one long transaction
   is better on a direct connection.
3. Pick the cutoff: an ISO time that has passed, e.g. the moment you start,
   `2026-11-16T12:00:00Z`. Accounts created before it are deleted.
4. Write down the numbers to keep (yours if you also have a rider account,
   pilot testers), in the `+233XXXXXXXXX` form, comma-separated.

## 1. Dry run

```bash
cd apps/server
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
CLOUDINARY_CLOUD_NAME="$PROD_CLOUDINARY_CLOUD_NAME" CLOUDINARY_API_KEY="$PROD_CLOUDINARY_API_KEY" CLOUDINARY_API_SECRET="$PROD_CLOUDINARY_API_SECRET" \
npm run reset:test-data -- --before=2026-11-16T12:00:00Z --keep=+233XXXXXXXXX,+233YYYYYYYYY
```

Check, in what it prints:

- `Database endpoint: ep-empty-violet-bay5yr3y  ← PRODUCTION`
- `Cloudinary account:` your production account's name
- **Rows deleted**: the numbers look like your test data
- **Accounts kept**: you, the admins, both review demo accounts and every
  `--keep` number are listed (phones are masked: `+233*****146`)
- **Photos left alone**: empty, or only photos you know are elsewhere

Nothing is written by a dry run. Run it as often as you like.

## 2. Real run

The same command with `--confirm=RESET-CAMPUSRIDE` at the end:

```bash
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
CLOUDINARY_CLOUD_NAME="$PROD_CLOUDINARY_CLOUD_NAME" CLOUDINARY_API_KEY="$PROD_CLOUDINARY_API_KEY" CLOUDINARY_API_SECRET="$PROD_CLOUDINARY_API_SECRET" \
npm run reset:test-data -- --before=2026-11-16T12:00:00Z --keep=+233XXXXXXXXX,+233YYYYYYYYY --confirm=RESET-CAMPUSRIDE
```

It ends with `Database: committed.` and a Cloudinary line. If it stops with
an error before that, nothing in the database changed. If some photos failed,
they're listed; delete them by hand in Cloudinary → Media Library
(`campusride/driver-photos/driver_<id>`) or ignore them.

Then:

1. **Restart the server:** Render → `campusride-server` → Manual Deploy →
   **Restart service**. This clears what it keeps in memory (rate limits,
   driver positions, cached admin figures).
2. In the terminal: `unset PROD_URL PROD_CLOUDINARY_CLOUD_NAME PROD_CLOUDINARY_API_KEY PROD_CLOUDINARY_API_SECRET`.

## 3. Check it in the admin site

1. **Overview:** rides, riders and drivers at 0 (or only what came after
   the cutoff). The review demo's trips never show here anyway.
2. **Riders** and **Drivers:** only the kept accounts.
3. **Finances:** nothing owed, nothing paid, no Paystack payments.
4. **Live map:** no cars from deleted drivers.
5. **Safety:** no SOS records.
6. **Settings → Audit log:** a `data.reset` entry by `script:resetTestData`
   with the cutoff and the counts. Launch mode and the commission rules are
   unchanged.
7. On a phone: the review demo numbers still sign in, and a kept rider
   account still works.

## If it went wrong

Switch the server to the backup branch you took first
([backup-and-restore.md](backup-and-restore.md#b-older-than-6-hours-switch-the-server-to-a-backup-branch)),
or rewind production in Neon if it's within 6 hours
([A. rewind](backup-and-restore.md#a-within-the-last-6-hours-rewind-production-in-place)).
