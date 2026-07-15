# Environments & Database Workflow

CampusRide uses **three isolated databases**, all Neon branches of one project:

| Env | NODE_ENV | Neon branch | Local env file | Who uses it |
|---|---|---|---|---|
| Production | `production` | `main` (compute host `ep-ancient-butterfly…`) | **none** — values live only in Render | The deployed server |
| Development | `development` | `dev` (`ep-flat-rain…`) | `apps/server/.env.development` | `npm run dev`, local scripts |
| Test | `test` | **local Postgres** (`localhost:5432/rida_test`) | `apps/server/.env.test` | `vitest` (creates/deletes rows) |

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

Prisma **CLI** commands (`migrate`, `seed`) do *not* read `config.ts`; they read
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
   > `db:migrate` reads real env vars / `.env`. Do **not** run it locally once the
   > local prod `.env` is removed — there will be no prod URL to target, which is
   > the intended safety behavior. Run it from the Render shell / CI where the
   > prod `DATABASE_URL`/`DIRECT_URL` are injected.

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

All `db:*:dev` / `db:*:test` scripts run `db:guard` first
([src/scripts/assertNonProdDb.ts](../apps/server/src/scripts/assertNonProdDb.ts)),
which shares the prod-host allowlist ([src/db/dbHostGuard.ts](../apps/server/src/db/dbHostGuard.ts))
with the vitest setup guardrail — so none of them can run against production.

## Follow-up (after Phase 1 secret rotation)

Once production secrets are rotated and set in Render, **delete the local
`apps/server/.env`** (the pre-split file that pointed at production). Prod creds
should then exist only in Render, and local `db:migrate` will safely no-op for
lack of a prod URL.
