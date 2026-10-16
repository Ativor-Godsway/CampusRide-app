# Backups and restoring the database

How to keep a copy of CampusRide's production data, and how to get it back.
Written for the owner, step by step. Pre-launch hardening, Stage 6
(2026-10-16).

The database is Postgres on **Neon**; production is the `main` branch
(Frankfurt). Everything that matters is in it:
accounts, rides, ratings, driver profiles, places. The apps and the server
can be rebuilt from git; the data can't.

## What Neon gives you on the free plan

From [Neon's free plan limits](https://neon.com/faqs/free-plan-limits-and-quotas)
(checked 2026-10-16):

| | Free plan |
|---|---|
| **Instant restore history** | **6 hours** (capped at 1 GB of changes): you can rewind production to any moment in the last 6 hours |
| **Branches** | 10 per project. Production, development and every backup branch count. |
| **Manual snapshots** | 1 |
| **Storage** | 1 GB per project |

So on the free plan, **anything older than 6 hours can only come back from a
copy you made**. That's what the weekly backup branch is for. Paid plans keep
days of history instead of hours.

## Every week: make a backup branch (5 minutes)

A Neon branch is a full copy of the database at a moment in time, made
instantly. It costs almost no storage until the two copies drift apart.

1. Open [console.neon.tech](https://console.neon.tech) → the CampusRide
   project → **Branches** → **New branch**.
2. **Parent branch:** `main`, the production branch the live server uses
   (DEPLOY.md, "Production at a glance").
3. **Name:** `backup-YYYY-MM-DD`, with today's date, e.g. `backup-2026-10-19`.
4. Include: **Current data**.
5. **Untick "Automatically delete branch after"**, or the backup deletes
   itself after a day.
6. **Create.**
7. Delete the oldest `backup-…` branch so you keep **the last four** (a
   month). With production and development that's six of the ten branches
   allowed.

Do it on the same day each week, for example Sunday evening, when few people
ride. A backup branch doesn't run a compute until someone connects to it, so
it uses no compute hours.

## Restoring

First decide **when** the data was last right, and **what** went wrong:
everything, or a few rows.

### A. Within the last 6 hours: rewind production in place

For "a bad change an hour ago broke things". This puts the **whole**
database back to that moment: anything written since is lost.

1. Neon console → the project → select the `main` branch.
2. **Postgres database → Backup & Restore → Restore from history.**
3. Check **Branch to restore** says `main`, the **From history** tab
   is selected, and pick the date and time just before the problem.
4. **Next**, read the confirmation, **Restore**.

It takes a few seconds; connection strings don't change, and the server
reconnects by itself. Neon keeps the state before the restore as a branch
named `main_old_<time>`, so a mistaken restore can be undone the same
way, choosing that branch.

### B. Older than 6 hours: switch the server to a backup branch

For "the data has been wrong since Tuesday". Neon can't copy a backup branch
back over production directly (only top-level branches can be a restore
source), so instead the server is pointed at the backup. Anything written
since the backup was made is lost.

1. Neon console → **Branches** → the `backup-…` branch from before the
   problem → **Connect**. Copy two connection strings: the **pooled** one
   (host ends in `-pooler`) and, with "Connection pooling" switched off, the
   **direct** one.
2. Add `?sslmode=require&pgbouncer=true&connection_limit=5` to the pooled
   one, the same as the current `DATABASE_URL` on Render (DEPLOY.md shows
   the format).
3. Render → `campusride-server` → Environment: set `DATABASE_URL` to the
   pooled string and `DIRECT_URL` to the direct one. **Save**; Render
   redeploys.
4. Check `/health/ready` says `"database":"ok"`, sign in to the admin site and
   look at recent rides.
5. Afterwards, in Neon, **rename** the old `main` branch (e.g.
   `broken-YYYY-MM-DD`) and the backup branch to `main`, so the names
   say what's live. Keep the broken one until you're sure nothing in it is
   needed.

### C. A few rows, not everything

For "a driver profile was deleted by mistake". Make a branch of `main`
with **Past data** at a time before the mistake (within 6 hours), or use a
backup branch; open it in the Neon **SQL Editor**, find the rows, and copy
them back. Ask for help with this one: copying rows by hand into the live
database needs care.

## Optional: a copy on your Mac

A backup branch lives inside the same Neon project. If the project itself
were lost (an account problem, deleted by mistake), so would the branches. A
copy on your Mac protects against that.

`pg_dump` 18 is already installed (`/usr/local/opt/libpq/bin`).

1. Neon → **Branches** → `main` → **Connect**, connection pooling
   **off**: copy the **direct** connection string.
2. In Terminal:

   ```bash
   mkdir -p ~/CampusRideBackups
   /usr/local/opt/libpq/bin/pg_dump "<the direct connection string>" \
     --format=custom --no-owner --no-privileges \
     --file ~/CampusRideBackups/campusride-$(date +%F).dump
   ```

   Paste the connection string inside the quotes. It contains the database
   password: don't save it in a file, and clear the terminal afterwards.
3. Check it worked: the file should be at least a few hundred KB.

   ```bash
   /usr/local/opt/libpq/bin/pg_restore --list ~/CampusRideBackups/campusride-$(date +%F).dump | head
   ```

**This file holds every rider's and driver's phone number and trips.**
Keep it only on this Mac, with FileVault on (System Settings → Privacy &
Security → FileVault); not in iCloud Drive, Dropbox, Google Drive, email or
chat. Delete copies older than a couple of months.

**Restoring from it** always goes into a fresh branch, never straight over
production:

1. Neon → **New branch** (any parent, **Current data**), named e.g.
   `restored-YYYY-MM-DD`. If the whole Neon project was lost, create a new
   project instead and use its default branch.
2. Copy that branch's **direct** connection string, then:

   ```bash
   /usr/local/opt/libpq/bin/pg_restore --no-owner --no-privileges --clean --if-exists \
     --dbname "<that branch's direct connection string>" ~/CampusRideBackups/campusride-YYYY-MM-DD.dump
   ```

   `--clean` replaces whatever the branch held with the backup's contents.
3. Switch the server to that branch as in **B**.

## Proposal, not built: automatic off-site backups

Today every backup depends on someone remembering. A weekly job could do it
on its own:

- **What:** every Sunday night a GitHub Actions job runs `pg_dump` against
  production, **encrypts** the file with a key only you hold (`age`, with the
  private key kept offline), and uploads it to a private storage bucket
  (Backblaze B2 or Cloudflare R2, well within their free tiers), keeping the
  last 8 weeks.
- **Why encrypted:** the repository is public, and the copy leaves Neon. Even
  if the bucket or the job's logs leaked, the file is unreadable without your
  key.
- **What it needs:** the production database's direct connection string as a
  GitHub secret, a bucket and its upload key, and your public `age` key.

This copies everyone's data to a new place, so **it isn't built**: say if you
want it, and which bucket provider.
