# CampusRide — Deploying the server to Render

This document covers the repo-side configuration. The human does the Render
dashboard steps; no secrets live in this repo.

---

## What's being deployed

`apps/server` — the Fastify + Socket.io + Prisma backend.  
Only this service is deployed to Render. The mobile apps (apps/rider,
apps/driver) are distributed via Expo Go / EAS and connect to this server.

---

## Prerequisites

1. **Neon database provisioned** with the schema already applied.  
   Run migrations locally against the Neon database before the first deploy:
   ```
   DATABASE_URL=<direct-url> DIRECT_URL=<direct-url> npm run db:migrate --workspace=apps/server
   ```
   Subsequent schema changes: run `db:migrate` locally against Neon before
   pushing the code that depends on them. Auto-running migrations on deploy
   is intentionally disabled (the schema must be applied before the server
   starts or the app crashes).

2. **A Render account** and a new **Web Service** pointed at this repo.

---

## Render dashboard — exact settings

### Build & Deploy tab

| Setting | Value |
|---|---|
| **Root Directory** | *(leave blank — repo root)* |
| **Runtime** | Node |
| **Build Command** | `npm install && npm run build:server` |
| **Start Command** | `npm run start --workspace=apps/server` |
| **Node Version** | 20 (set in `.node-version` at repo root, or pin in Render) |

> The build command does four things in order:
> 1. `npm install` — installs all workspace dependencies at repo root.
> 2. `tsc -p tsconfig.build.json` (builds `packages/shared`) — emits
>    `packages/shared/dist/` so the server can resolve `@rida/shared` at runtime.
> 3. `prisma generate` (part of the server `build` script) — generates the Prisma
>    client from `apps/server/prisma/schema.prisma`.
> 4. `tsc -p tsconfig.build.json` (builds `apps/server`) — compiles TypeScript to
>    `apps/server/dist/`.

### Health Check tab

| Setting | Value |
|---|---|
| **Health Check Path** | `/health` |

Returns `{ "status": "ok", "app": "CampusRide" }` when the server is up.

---

## Environment variables (set in Render dashboard → Environment tab)

Set these as individual env vars — never commit actual values to the repo.

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string. **Must** include `pgbouncer=true&connection_limit=5`. See format below. |
| `DIRECT_URL` | Neon **direct** (non-pooled) connection string. Used by Prisma for migrations. |
| `JWT_SECRET` | Long random secret for signing access tokens. Generate with: `openssl rand -hex 32` |

#### DATABASE_URL format

The pooled URL comes from the Neon dashboard → your project → Connection string
→ **"Pooled connection" toggled ON**. Append the required Prisma/PgBouncer
parameters:

```
postgresql://<user>:<password>@<pooler-host>.neon.tech/<dbname>?sslmode=require&pgbouncer=true&connection_limit=5
```

- `pgbouncer=true` — disables Prisma's named prepared statements, which
  PgBouncer's transaction-mode pooling does not support.
- `connection_limit=5` — caps Prisma's internal connection pool so it doesn't
  exhaust Neon's plan limits alongside other processes.  
  Bump to 10 only if you upgrade to a Neon plan with a higher connection limit.

#### DIRECT_URL format

The direct URL comes from Neon → Connection string → **"Pooled connection"
toggled OFF**:

```
postgresql://<user>:<password>@<direct-host>.neon.tech/<dbname>?sslmode=require
```

### Feature flags (set these explicitly for first deploy)

| Variable | Value for first deploy | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Disables dev-only behaviour. |
| `MOOLRE_ENABLED` | `false` | Keeps DummyPaymentService active — no real payments. |
| `OTP_PROVIDER` | `dummy` | Logs OTPs to the server console; no SMS sent. Switch to `moolre` or `mnotify` when SMS is configured. |
| `ENABLE_MOCK_DRIVER` | `false` | Mock driver is dev-only; never enable in production. |

### Render-managed (do NOT set manually)

| Variable | Notes |
|---|---|
| `PORT` | Render injects this automatically. The server reads `process.env.PORT` and binds `0.0.0.0`. Do not override. |

### Optional (leave unset until SMS/payments are configured)

`MOOLRE_BASE_URL`, `MOOLRE_API_USER`, `MOOLRE_PUBLIC_KEY`,
`MOOLRE_PRIVATE_KEY`, `MOOLRE_ACCOUNT_NUMBER`, `MOOLRE_WEBHOOK_SECRET`,
`MOOLRE_VAS_KEY`, `MOOLRE_SMS_SENDER_ID`,
`MNOTIFY_ENABLED`, `MNOTIFY_API_KEY`, `MNOTIFY_SENDER_ID`

---

## Reading OTPs in dummy mode

With `OTP_PROVIDER=dummy`, every OTP is printed to the server's **Logs** tab
in the Render dashboard (look for a line like `[DummyOtpService] OTP for
+233… is 123456`). This is intentional for the first deploy — flip to a real
SMS provider once the service is stable.

---

## Free tier notes

- Render free-tier web services **spin down after ~15 minutes of inactivity**
  and take 30–60 s to cold-start on the next request. This is fine for
  development/demo use. Upgrade to a paid plan ("Starter" or higher) when
  cold-starts are unacceptable.
- Neon's free tier also pauses after inactivity — keep both on the same
  tier/activity pattern to avoid mismatched cold-start timeouts.

---

## render.yaml

`render.yaml` at the repo root defines the service for Render's
Infrastructure-as-Code flow (connect repo → Render detects the yaml →
prompts to create services). It lists env var names but no secret values.
You still need to set `DATABASE_URL`, `DIRECT_URL`, and `JWT_SECRET` in the
Render dashboard after the service is created.

---

## CI, and the manual step that makes it a deploy gate

`.github/workflows/ci.yml` runs on every push to `main` and every PR
targeting `main`, in three parallel jobs:

| Job | What it does |
| --- | --- |
| **Lint, typecheck & shared tests** | `npm ci`, `prisma generate`, `npm run lint`, `npm run typecheck` (all five workspaces), then `packages/shared`'s suite with coverage. No database. |
| **Server tests (Postgres)** | Boots a `postgres:16` service container, creates `apps/server/.env.test` from the committed template, then `db:migrate:test` → `db:seed:test` → the full server suite with coverage. |
| **Dependency audit** | `scripts/audit-check.mjs` — fails on any *new* high/critical npm advisory. |

Coverage is printed but **not** threshold-gated: there is no agreed baseline
yet. Today it sits at ~96% for `packages/shared` and ~64% for `apps/server`.

### ⚠️ Required manual step: branch protection

**CI does not block deploys on its own.** Render watches the `main` branch,
not the CI result, so a red build still auto-deploys unless GitHub refuses
the push or merge first. A workflow file cannot grant itself that authority —
it has to be switched on by hand, once, in the GitHub UI:

> **Settings → Branches → Add branch ruleset** (or *Add protection rule*) for `main`
>
> 1. **Require a pull request before merging**
> 2. **Require status checks to pass before merging**, selecting all three:
>    - `Lint, typecheck & shared tests`
>    - `Server tests (Postgres)`
>    - `Dependency audit`
> 3. **Require branches to be up to date before merging**
> 4. Optionally restrict direct pushes to `main`
>
> The status checks only appear in that picker *after* the workflow has run at
> least once, so push this commit first, then add the rule.

Optionally also set the Render service's auto-deploy to *After CI checks
pass* (Render dashboard → service → Settings → Build & Deploy), or turn
auto-deploy off and deploy manually once CI is green.

### The audit allowlist

`npm audit --audit-level=high` on its own would fail every build today: the
repo carries four known high advisories in `expo@54`'s build toolchain
(`image-size`, `postcss`) that can only be cleared by an `expo@54 → 57`
migration, accepted as out of scope in Phase 2. A gate that is red from day
one gets ignored, so instead `scripts/audit-check.mjs` compares the audit
against `.audit-allowlist.json` and fails only on advisories that are *not*
listed. Each exception carries a reason and a `reviewBy` date, and the script
also reports stale entries so the list shrinks as things get fixed.

To accept a new finding, add an entry with a real justification — not just an
id. To see the current state locally: `node scripts/audit-check.mjs`.

---

## Admin app (Phase 5) — manual Render step

`render.yaml` now describes a second service, `campusride-admin`: the static
Vite/React SPA in `apps/admin` that runs the driver approval queue and the ride
oversight list. **The blueprint file does not create the service.** Connecting
it is a dashboard action, and must be done by hand:

1. Render dashboard → **New → Static Site**, pointing at this repository.
2. **Name:** `campusride-admin` · **Region:** same as `campusride-server`.
3. **Build command:** `npm install && npm run build:admin`
4. **Publish directory:** `apps/admin/dist`
5. **Redirects/Rewrites:** add a rewrite `/*` → `/index.html` (SPA routing —
   without it a page refresh returns 404).
6. **Environment → `VITE_API_URL`**: the public URL of `campusride-server`,
   e.g. `https://campusride-server.onrender.com`, with no trailing slash.
   Vite inlines this at build time, so changing it needs a **redeploy**.
7. Once Render assigns the static site its URL, go back to
   **campusride-server → Environment** and add that origin to
   `CORS_ALLOWED_ORIGINS` (comma-separated alongside any existing value), then
   let the server redeploy. The admin app is a browser client; in production
   the API grants no origin that is not on this list, so until this is done
   every admin request fails in the browser while the API itself is healthy.

### Creating the first admin account

No one can sign up as an admin: `POST /auth/signup` accepts `RIDER|DRIVER`
only. The first admin is promoted by hand, against the target database:

```bash
# The person must already have an account (sign up in the rider app first).
cd apps/server
DATABASE_URL="<production pooled connection string>" \
  npx ts-node -r tsconfig-paths/register src/scripts/seedAdmin.ts 0XXXXXXXXX
```

The promotion is itself written to `AdminAuditLog` (actor `script:seedAdmin`).
The promoted user must log out and back in — an access token issued before the
change still carries the old role.
