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
