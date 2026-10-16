# CampusRide — Deploying the server to Render

This document covers the repo-side configuration. The human does the Render
dashboard steps; no secrets live in this repo.

---

## What's being deployed

`apps/server` — the Fastify + Socket.io + Prisma backend.  
Only this service is deployed to Render. The mobile apps (apps/rider,
apps/driver) are distributed via Expo Go / EAS and connect to this server.

---

## Production at a glance

| What | Value |
|---|---|
| **API (public URL)** | `https://api.campusride.app` — HTTP and Socket.io (`wss://`) on the same origin |
| **Health check** | `https://api.campusride.app/health` |
| **Render service** | `campusride-server` (Web Service), region **Frankfurt** |
| **Database** | Neon `main` branch, Frankfurt / eu-central-1 (same region as the API) |
| **Admin site** | `campusride-admin` (Static Site), calls the API above |
| **SOS tracking links** | `https://api.campusride.app/track/<token>` (from `PUBLIC_BASE_URL`) |

Every client uses `api.campusride.app`, never a `*.onrender.com` address, so
the service behind the name can be replaced without an app release. The
previous server, `https://campusride-server-aaum.onrender.com` (Oregon), is
being retired; nothing in the repo points at it any more.

### The custom domain

`api.campusride.app` is a custom domain on the `campusride-server` service:

1. Render dashboard → `campusride-server` → **Settings → Custom Domains** →
   add `api.campusride.app`.
2. At the DNS provider for `campusride.app`, add the record Render shows: a
   `CNAME` from `api` to the service's `*.onrender.com` host.
3. Wait for Render to show the domain as **Verified** and the certificate as
   issued. Render serves HTTPS on it automatically.

`render.yaml` lists the domain under `domains:` so the blueprint matches.

---

## Mobile apps — which server a build talks to

The rider and driver apps resolve the API URL in this order
([packages/mobile-shared/src/config/serverUrl.ts](packages/mobile-shared/src/config/serverUrl.ts)):

1. `EXPO_PUBLIC_API_URL`, inlined into the bundle when it is built.
2. `expo.extra.SERVER_URL` in the app's `app.json` — also
   `https://api.campusride.app`, the fallback for a build with no value in (1).

For EAS builds, (1) comes from the build profile in `apps/rider/eas.json` and
`apps/driver/eas.json`:

| Profile | `EXPO_PUBLIC_API_URL` | EAS environment | Distribution |
|---|---|---|---|
| `production` | `https://api.campusride.app` | `production` | store |
| `preview` | same (extends `production`) | `production` | internal (installable link) |
| `development` | same (extends `production`) | `production` | internal (installable link) |

Each profile is also an EAS Update **channel** of the same name.

The URL lives in `eas.json` rather than in the expo.dev dashboard because it
is public and belongs in review: a change to it shows up in a PR. Keep it in
one place — don't also create `EXPO_PUBLIC_API_URL` as an EAS environment
variable on expo.dev, or the two can drift apart. The profiles still set
`"environment": "production"`, so a value that must stay out of git can later
be added on expo.dev (project → **Environment variables**, environment
`production`) and reach the build. Anything named `EXPO_PUBLIC_*` ends up in
the shipped bundle, so never put a secret there.

The apps' `.env` files are gitignored, so EAS never uploads them; a cloud
build sees only what `eas.json` and expo.dev provide. An over-the-air update
is different: `eas update` bundles on your Mac, where `.env` *is* read — so
publish with `scripts/eas-update.sh`, which sets (1) from `eas.json` first.

Under `expo start`, (1) comes from the app's `.env` files instead, and
`.env.development.local` can point it at a server on your Mac
([docs/testing/SOLO_TESTING.md](docs/testing/SOLO_TESTING.md)). A release build
refuses a local or Wi-Fi address and falls back to (2).

Build commands, run from the app's directory (`apps/rider` or `apps/driver`):

```bash
npx eas-cli@latest build --profile production --platform all
npx eas-cli@latest build --profile preview --platform android   # test build
```

Shipping a release — over-the-air update or new store build, rollback, and
checking what a phone runs — is a step-by-step guide of its own:
[docs/runbooks/releasing.md](docs/runbooks/releasing.md).

The apps are linked to the `campusride-gh` Expo organization
(`@campusride-gh/campusride-rider`, `@campusride-gh/campusride-driver`).

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
| **Start Command** | `node apps/server/dist/apps/server/src/index.js` |
| **Node Version** | 20 (set in `.node-version` at repo root, or pin in Render) |

> **Start Command:** `node` directly, not `npm run start …`. On a deploy
> Render sends the old server a stop signal (SIGTERM); with npm in between,
> the signal reached the server twice and killed it instantly, so it never
> finished its in-flight requests or logged `"event":"shutdown"`. The server
> now copes with that too, but starting it directly is the clean setup.
>
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
Keep Render on `/health`, which never touches the database. The outside
monitor (UptimeRobot) uses `/health/ready`, which also checks the database:
see [Monitoring](#monitoring-sentry-uptimerobot-neon).

---

## Environment variables (set in Render dashboard → Environment tab)

Set these as individual env vars — never commit actual values to the repo.

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string. **Must** include `pgbouncer=true&connection_limit=5`. See format below. |
| `DIRECT_URL` | Neon **direct** (non-pooled) connection string. Used by Prisma for migrations. |
| `JWT_SECRET` | Long random secret for signing access tokens, at least 32 random bytes. Generate with: `openssl rand -hex 32` |
| `PUBLIC_BASE_URL` | `https://api.campusride.app` — SOS tracking links are built from it. |
| `CORS_ALLOWED_ORIGINS` | The admin site's origin, e.g. `https://campusride-admin.onrender.com`. |
| `ADMIN_PHONE_ALLOWLIST` | The admin's phone number(s), comma-separated. Nobody else can use the admin site. |
| `SUPPORT_CONTACT_PHONE` | Texted on every SOS. |
| Login-code SMS | `OTP_PROVIDER=moolre`, `MOOLRE_SMS_ENABLED=true`, `MOOLRE_VAS_KEY`, `MOOLRE_SMS_SENDER_ID`. |

The server checks all of these at start-up in production and refuses to run
if one is missing or invalid (see
[docs/security/admin-and-secrets.md](docs/security/admin-and-secrets.md#what-the-server-refuses-to-start-without-production)).

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
| `OTP_PROVIDER` | `moolre` | Sends login codes by SMS. `dummy` (no SMS) is for local development only: production refuses to start with it. |
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

Routes between exact pins (defaults are right for now; see
[docs/routing.md](docs/routing.md#routes-between-exact-pins-per-trip)):
`OSRM_BASE_URL` (a self-hosted OSRM, once we outgrow the public one),
`ROUTING_DISABLED`, `ROUTING_TIMEOUT_MS`, `ROUTING_MIN_INTERVAL_MS`,
`ROUTING_DAILY_WARN_AT`, `RATE_LIMIT_ROUTE_LEGS`

Ride offers: `DRIVER_OFFER_SECONDS` (default 15, 5–60) — how long a ride
offer's countdown runs on the driver's screen. The app reads it from each
offer, so changing it needs no app release.

**Required in production** — the server refuses to start without these, and
logs which are missing (names only): `DATABASE_URL`, `DIRECT_URL`,
`JWT_SECRET` (32+ random bytes), `PUBLIC_BASE_URL` (https), 
`CORS_ALLOWED_ORIGINS`, `ADMIN_PHONE_ALLOWLIST`, `SUPPORT_CONTACT_PHONE`, and
working login-code SMS settings. The full list and rules:
[docs/security/admin-and-secrets.md](docs/security/admin-and-secrets.md#what-the-server-refuses-to-start-without-production).
Admin sessions: `ADMIN_ACCESS_TOKEN_MINUTES` (10), `ADMIN_IDLE_MINUTES` (30),
`ADMIN_SESSION_MAX_HOURS` (8).

Rate limits: every limit is a `RATE_LIMIT_*` variable with a sensible default
(full list: [docs/security/rate-limits.md](docs/security/rate-limits.md)).
Leave them unset unless a limit needs changing. **Don't set `TRUST_PROXY`**:
unset, the server finds the real client IP behind Cloudflare and Render's load
balancer. After each deploy, the log line `client_ip_check` should say
`"resolvedToClient":true`.

SOS tracking links: `TRACKING_LINK_TTL_HOURS` (default 24, 1–168) — how long
a link texted by an SOS keeps working after the ride ends. While the ride is
going on it always works. See
[docs/security/route-inventory.md](docs/security/route-inventory.md).

Logs: `LOG_LEVEL` (default `info`) — leave unset. Phone numbers, codes and
tokens are scrubbed from every line; every response has an `X-Request-Id`, and
searching the logs for it finds that request. A deploy shuts the old server
down cleanly (in-flight requests finish first). See
[docs/security/validation-and-errors.md](docs/security/validation-and-errors.md).

Monitoring: `SENTRY_DSN` (error reports and alerts; unset = off),
`SENTRY_TRACES_SAMPLE_RATE` (default 0.02), `MOOLRE_SMS_LOW_BALANCE`
(default 100). Setting up: [Monitoring](#monitoring-sentry-uptimerobot-neon).

Push notifications ([docs/runbooks/push-notifications.md](docs/runbooks/push-notifications.md))
need no server variable. `PUSH_DISABLED=true` switches every send off without
touching the ride flow. `EXPO_ACCESS_TOKEN` is needed only if "Enhanced
Security for Push Notifications" is turned on for the Expo account — it is a
secret, so set it in the dashboard only.

---

## Login codes in development

With `OTP_PROVIDER=dummy` (local development only), no SMS is sent and a
development server prints each code in its own terminal. Production refuses
to start with the dummy provider, so codes are never written to Render's logs.

---

## Monitoring (Sentry, UptimeRobot, Neon)

How you find out something is wrong before riders tell you. What each piece
does, and what it never sends: [docs/security/monitoring.md](docs/security/monitoring.md).
Everything below is optional in the sense that the app runs without it, but
do it before launch. About 45 minutes in all.

### 1. Create the Sentry projects (once)

1. Go to [sentry.io](https://sentry.io) and sign up. The free **Developer**
   plan is enough. Sentry asks for an organization name: use `campusride`.
   Its **slug** (Settings → General Settings) is needed in step 5.
2. Create **four projects** (Projects → Create Project). Use exactly these
   names; the release script relies on the two app names.

   | Project name | Platform to choose |
   |---|---|
   | `campusride-server` | Node.js |
   | `campusride-admin` | React |
   | `campusride-rider` | React Native |
   | `campusride-driver` | React Native |

   When Sentry asks how often to alert you, choose **alert me on every new
   issue**. Skip the setup instructions it shows afterwards; the code is
   already in place.
3. Each project has a **DSN**: Project → Settings → Client Keys (DSN). It
   looks like `https://3f9a…@o4507….ingest.de.sentry.io/4507…` (the
   CampusRide organization is in Sentry's EU region, hence `.de.`). A DSN is not
   a password (it ends up inside the apps), but keep it out of public posts.

### 2. The server

1. Render → `campusride-server` → Environment → add `SENTRY_DSN` = the
   `campusride-server` DSN → Save changes. Render redeploys.
2. In the deploy's logs, look for `Error reporting to Sentry is on`.
3. Optional check from this Mac (sends one test message, touches no
   database):

   ```bash
   SENTRY_DSN="<the campusride-server DSN>" npm run sentry:test --workspace=apps/server
   ```

   It appears under **Issues** in `campusride-server` within a minute.
   Resolve it afterwards.

### 3. The admin site

1. Render → `campusride-admin` → Environment → add `VITE_SENTRY_DSN` = the
   `campusride-admin` DSN → Save.
2. **Manual Deploy → Deploy latest commit.** The DSN is built into the site,
   so it only takes effect after a new build.
3. The site's Content-Security-Policy must allow Sentry, or the browser
   blocks the reports (the site itself keeps working). The site isn't
   managed by `render.yaml`, so change it by hand: Render →
   `campusride-admin` → Settings → Headers → edit
   `Content-Security-Policy` (path `/*`) and replace its value with:

   ```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://res.cloudinary.com https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self' https://api.campusride.app https://*.ingest.de.sentry.io; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests
   ```

   The only change from before Stage 5 is `https://*.ingest.de.sentry.io`
   in `connect-src`: Sentry's EU intake, where this organization's DSNs
   point. (An organization in Sentry's US region would need
   `https://*.ingest.us.sentry.io` instead.)

### 4. The rider and driver apps

1. On [expo.dev](https://expo.dev), open the **rider** project →
   Environment variables → Add variable:
   - Name: `EXPO_PUBLIC_SENTRY_DSN`
   - Value: the `campusride-rider` DSN
   - Environment: **production** (every build and update uses it)
   - Visibility: **Plain text**. Not "Secret": over-the-air updates are
     bundled on this Mac, which can't read secret values.
2. The same in the **driver** project, with the `campusride-driver` DSN.
3. Make **new builds** of both apps ([docs/runbooks/releasing.md](docs/runbooks/releasing.md)).
   Sentry is native code, so only builds made from now on have it, and
   over-the-air updates published from now on reach only those builds.
   Publish any update still waiting for the current builds **before**
   merging the Stage 5 change.

### 5. Readable app errors (optional, recommended)

Without this, errors from the apps show compiled code instead of file names
and lines. Sentry → Settings → Auth Tokens → **Create New Token**
(an organization token). Then, in the terminal where you release an update:

```bash
export SENTRY_AUTH_TOKEN="<the token>" SENTRY_ORG="<your organization slug>"
bash scripts/eas-update.sh rider production "what changed"
```

The script uploads the update's source maps after publishing. Never put the
token in a file in this repository.

### 6. Email alerts

Sentry emails you the first time each new problem appears, if you chose
"every new issue" in step 1. Check it in each project → Alerts: there should
be a rule that sends a notification when a new issue is created. Alerts the
server raises itself (failed SMS, push failures, database trouble, a low
SMS balance…) arrive the same way, each with an `alert` tag saying which.

### 7. UptimeRobot: watch `/health/ready`

1. [uptimerobot.com](https://uptimerobot.com) → your CampusRide monitor →
   Edit.
2. URL: `https://api.campusride.app/health/ready`. Keep the type HTTP(s)
   and the 5-minute interval. Save.
3. It should show **Up**. From now on it also goes **Down** (and emails
   you) when the server is up but can't reach the database, which
   `/health` never noticed.

Leave Render's own health check on `/health`.

### 8. Neon: check compute hours every week

Neon's free plan includes **100 compute-hours per project per month**. When
they run out, Neon suspends the database until the next month, and the app
stops working ([Neon's limits](https://neon.com/faqs/free-plan-limits-and-quotas)).

- **Where:** [console.neon.tech](https://console.neon.tech) → the project →
  Billing (or Usage) → compute used this month.
- **Why it matters here:** Neon's database sleeps after 5 idle minutes, but
  this server never lets it. It checks for timed-out rides every 30 seconds,
  and UptimeRobot's visits keep Render's free server awake. Awake all month
  at the smallest size, the database uses about 6 compute-hours a day,
  around 180 a month, so the free allowance runs out around the 17th.
  Development branches in the same project count too.
- **What to do:** check the number weekly. If it's on course to run out,
  don't wait: a paid Neon plan or a change to how the server uses the
  database is needed before launch (Stage 6 recommends one).

### 9. Moolre SMS balance

The server warns (Sentry and logs) when the balance drops below 100
(`MOOLRE_SMS_LOW_BALANCE`). It reads the balance with a call Moolre doesn't
document publicly, so if you get "Couldn't read the Moolre SMS balance",
or just to be safe, check it by hand weekly on the Moolre dashboard
([app.moolre.com](https://app.moolre.com)), which shows the SMS balance.
Top up well before it runs out: with no SMS, nobody can sign in.

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

## CI, and the ruleset that makes it a deploy gate

`.github/workflows/ci.yml` runs on every push to `main` and every PR
targeting `main`, in three parallel jobs:

| Job | What it does |
| --- | --- |
| **Lint, typecheck & shared tests** | `npm ci`, `prisma generate`, `npm run lint`, `npm run typecheck` (all five workspaces), then `packages/shared`'s suite with coverage. No database. |
| **Server tests (Postgres)** | Boots a `postgres:16` service container, creates `apps/server/.env.test` from the committed template, then `db:migrate:test` → `db:seed:test` → the full server suite with coverage. |
| **Dependency audit** | `scripts/audit-check.mjs` — fails on any *new* high/critical npm advisory. |

Coverage is printed but **not** threshold-gated: there is no agreed baseline
yet. Today it sits at ~96% for `packages/shared` and ~64% for `apps/server`.

### Branch protection — in place

**CI does not block deploys on its own.** Render watches the `main` branch,
not the CI result, so a red build would auto-deploy unless GitHub refuses the
merge first. A workflow file cannot grant itself that authority.

That gate is now switched on: a repository ruleset on `main` requires a pull
request plus all three status checks —

- `Lint, typecheck & shared tests`
- `Server tests (Postgres)`
- `Dependency audit`

— so a commit reaches `main`, and therefore production, only after CI passes
on a PR.

> If the ruleset is ever disabled the gap reopens **silently**: CI keeps
> reporting pass/fail on PRs while blocking nothing. Check
> **Settings → Rules → Rulesets** before assuming a red build cannot ship.

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
2. **Name:** `campusride-admin` · **Region:** same as `campusride-server` (Frankfurt).
3. **Build command:** `npm install && npm run build:admin`
4. **Publish directory:** `apps/admin/dist`
5. **Redirects/Rewrites:** add a rewrite `/*` → `/index.html` (SPA routing —
   without it a page refresh returns 404).
6. **Environment → `VITE_API_URL`**: the public URL of `campusride-server`,
   `https://api.campusride.app`, with no trailing slash.
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
