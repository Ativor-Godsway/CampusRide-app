# Environments & Database Workflow

CampusRide uses **three isolated databases**, all Neon branches of one project:

| Env         | NODE_ENV      | Neon branch                                     | Local env file                        | Who uses it                     |
| ----------- | ------------- | ----------------------------------------------- | ------------------------------------- | ------------------------------- |
| Production  | `production`  | `main` (compute host `ep-ancient-butterfly…`)   | **none** — values live only in Render | The deployed server             |
| Development | `development` | `dev` (`ep-flat-rain…`)                         | `apps/server/.env.development`        | `npm run dev`, local scripts    |
| Test        | `test`        | **local Postgres** (`localhost:5432/rida_test`) | `apps/server/.env.test`               | `vitest` (creates/deletes rows) |

> The test suite runs against a **local Postgres**, not a remote Neon branch. It
> issues hundreds of sequential queries — locally that's ~12s and deterministic;
> against an auto-suspending Neon branch it was 400–540s/file with dropped
> connections and SIGSEGV. A Neon `test` branch (`ep-blue-union…`) exists and is
> kept as a commented fallback in `.env.test`. Start a local Postgres with
> `docker compose up -d` (repo-root `docker-compose.yml`) or use a native install.

The real `.env.development` / `.env.test` files are **gitignored**. Commit only
the `.env.*.example` templates. **Production secrets are never stored on disk** —
they live in the Render dashboard (Environment tab) only.

## How env loading works

`apps/server/src/config.ts` loads `.env.${NODE_ENV}` first, then `.env` as a
fallback. `dotenv` never overrides an already-set variable, so:

- Real environment variables (Render) always win → production is driven purely
  by Render's env, no file needed.
- Locally, `.env.development` (or `.env.test` under vitest) wins over any stray
  base `.env`.

Prisma **CLI** commands (`migrate`, `seed`) do _not_ read `config.ts`; they read
`.env` / real env vars. So the env-scoped scripts below use `dotenv-cli` to load
the correct file explicitly.

## Safety gate

`apps/server/src/test/setup.ts` throws before any query if `DATABASE_URL` points
at the production host (`ep-ancient-butterfly`). Running the test suite can never
touch production, even if `.env.test` is misconfigured.

## Migration workflow — dev first, prod as a deliberate act

Migrations are **never** run casually against production. The flow:

1. **Author + apply on dev:**
   ```bash
   npm run db:migrate:dev --workspace apps/server      # prisma migrate dev on the dev branch
   ```
2. **Apply the committed migration to the test branch** (so tests see the new schema):
   ```bash
   npm run db:migrate:test --workspace apps/server     # prisma migrate deploy on the test branch
   ```
3. **Commit** the generated `prisma/migrations/**` files and open a PR.
4. **Deploy to production deliberately**, with prod env, on Render (or CI) only:
   ```bash
   npm run db:migrate --workspace apps/server          # prisma migrate deploy, prod env
   ```
   > `db:migrate` reads real env vars / `.env`. Locally, `.env` holds only dev
   > values, so run there it targets the dev branch, never production. Run it
   > from the Render shell / CI, where the prod `DATABASE_URL`/`DIRECT_URL` are
   > injected.

### Bringing the dev branch up to date

To apply migrations that are already committed (e.g. after pulling), use
`db:deploy:dev`. `db:migrate:dev` is for **authoring** a new migration: it runs
`prisma migrate dev`, which can offer to reset the database if it detects drift.

```bash
npm run db:status:dev     # what is missing (read-only)
npm run db:deploy:dev     # prisma migrate deploy against .env.development
```

All `db:*:dev` scripts (`migrate`, `deploy`, `status`, `seed`, `reset`) run
`db:guard:dev` first ([src/db/devDbGuard.ts](../apps/server/src/db/devDbGuard.ts)),
which allows only local Postgres or the dev branch and refuses production with
no override. See [testing/SOLO_TESTING.md](testing/SOLO_TESTING.md).

## Database time limits

Since migration `20261002120000_database_timeouts`, every database we migrate
(dev, production, local test) carries these settings:

| Setting                               | Value | Why                                                                                                                                                                |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lock_timeout`                        | 10 s  | Waiting for a row another transaction holds gives up after 10 s. The request fails with a 500; the driver app retries quietly (every driver action is idempotent). |
| `statement_timeout`                   | 30 s  | No single statement runs longer than 30 s.                                                                                                                         |
| `idle_in_transaction_session_timeout` | 60 s  | A session left inside a transaction with nothing happening is ended, which releases its locks.                                                                     |

**Why (the 29-minute stall, 2026-10-01).** Under a deliberately slow link
(1.4 s per round trip), one request waited 29 minutes. Reproduced on its own:
when Prisma gives up on an interactive transaction (error P2028), the
database session is still _inside_ that transaction, holding its row locks,
until Prisma's ROLLBACK arrives. With `lock_timeout` and
`statement_timeout` at 0 (no limit) — the default on plain Postgres and on
our Neon branches — anything that needs those rows waits for as long as that
takes; Neon only ends an idle transaction after 5 minutes, plain Postgres
never. In the isolated runs the ROLLBACK arrived within ~2 s; the exact
condition that delayed it for 29 minutes wasn't reproduced. With the limits
above, no wait can exceed ~10 s for a lock or 60 s for an abandoned session.

They are database settings, not schema: no table or row changes. They apply
to **new** connections, so restart the server after deploying. The migration
needs the migrating role to own the database (it does on our Neon branches);
otherwise it only warns, and the owner must run the three `ALTER DATABASE …
SET` lines from the migration by hand. Check what a database has with
`SHOW lock_timeout; SHOW statement_timeout; SHOW idle_in_transaction_session_timeout;`
from a new connection.

## Seeding

Seeds are idempotent (zones seed only on an empty table; ZoneAdjacency uses
`skipDuplicates`). `SEED_ZONE_ADJACENCY=false` seeds **zones only** — the test DB
uses this because the dispatch/assembly eligibility tests build their own sparse
adjacency edges and a pre-seeded full mesh both collides on the unique constraint
and breaks "distant zone is not adjacent" assumptions.

```bash
npm run db:seed:dev  --workspace apps/server    # zones + 210-row ZoneAdjacency (meshed)
npm run db:seed:test --workspace apps/server    # zones only (SEED_ZONE_ADJACENCY=false)
```

## Running the test suite (local Postgres)

```bash
docker compose up -d                                    # or use a native local Postgres
cd apps/server
npm run db:reset:test    # host-gated: drops + re-applies migrations on the local test DB
npm run db:seed:test     # zones only
npm test                 # ~12s, deterministic
```

All `db:*:test` scripts run `db:guard` first
([src/scripts/assertNonProdDb.ts](../apps/server/src/scripts/assertNonProdDb.ts)),
which shares the prod-host allowlist ([src/db/dbHostGuard.ts](../apps/server/src/db/dbHostGuard.ts))
with the vitest setup guardrail — so none of them can run against production.
The `db:*:dev` scripts run `db:guard:dev` instead (local Postgres or the dev
branch only), since `db:guard` would refuse the dev Neon branch.

## The base `apps/server/.env`

`apps/server/.env` (gitignored) holds the **same dev values** as
`.env.development` and nothing from production. It matters even though
`config.ts` loads `.env.development` first: `@prisma/client` reads `.env` the
moment it is imported, so any script that imports Prisma before `config.ts`
gets whatever `.env` says. It used to say production.

Production credentials (database, JWT, Moolre, mNotify, Cloudinary) exist only
in Render. For a deliberate one-off against production, pass the URL inline
from a variable you export yourself, never from a file:

```bash
export PROD_URL="postgresql://…"      # paste from Render, in this shell only
ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
  npx ts-node -r tsconfig-paths/register src/scripts/cleanupTestAccounts.ts
```
