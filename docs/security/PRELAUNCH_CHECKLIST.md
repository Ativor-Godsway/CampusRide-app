# Pre-launch security & reliability checklist

Every item of the six-stage hardening pass, and what only the owner can do.
Updated at the end of each stage.

✅ done · 🔶 done on a branch, waiting for merge · ⬜ not done

## Stage 1 — Permissions ✅ (PR #36)

| | Item |
|---|---|
| ✅ | Inventory of every HTTP route and Socket.io event: [route-inventory.md](route-inventory.md), checked against the code by a test |
| ✅ | Ownership enforced on every route; someone else's ride, seat or rating answers 404, same as one that doesn't exist |
| ✅ | OTP verification tokens can no longer be used as a login (they could watch other people's shared rides live) |
| ✅ | Roles come from the database, not the token; deleted accounts are refused even with an unexpired token |
| ✅ | Socket.io: token checked at the handshake; ride rooms only for the driver and riders still in the car; driver positions only from the ride's own driver; every payload validated |
| ✅ | Mass assignment: every write takes only allow-listed fields (role, approval, online status, fares, other people's ids can't be set), proven by tests |
| ✅ | A rider cancelling a shared car takes only themselves out; others keep their ride |
| ✅ | Ratings only between people who actually took the trip |
| ✅ | SOS links are per rider, show only that rider, and expire 24 h after the ride ends (`TRACKING_LINK_TTL_HOURS`) |
| ✅ | Contact numbers stop with the trip: no driver number on a cancelled ride; no rider number once they've left the car |
| ✅ | Table-driven cross-user tests for every route and socket event (rider vs rider, driver vs driver, rider vs admin) |

## Stage 2 — Per-person rate limiting ✅ (PR #37)

| | Item |
|---|---|
| ✅ | Report of the limits before this stage (key, numbers, store): [rate-limits.md](rate-limits.md#before-stage-2-2026-10-15) — they were effectively one bucket for the whole app |
| ✅ | Limits keyed to the person (phone before login, account after, link for `/track`); IP only as a generous backstop on routes nobody is signed in to |
| ✅ | Real client IP behind Render (trust private + Cloudflare ranges, not a hop count), proven by a test; the IP backstop switches itself off rather than ever pooling people |
| ✅ | Limits on every costly route (codes, refresh, booking, cancel, accept/decline, ratings, profile, push tokens, uploads, deletion, payments, tracking pages, sockets); SOS never refused, only repeat texts held back; driver GPS throttled, never disconnected |
| ✅ | Every 429 has `Retry-After` and `retryAfterSeconds`; rider, driver and admin apps say "Try again in X"; code screens count down 60 s to "Resend code" |
| ✅ | One store interface (in memory now, Redis-ready), documented |
| ✅ | Admin "Rate limits" screen: look up a number, clear it; both audit-logged |
| ✅ | 10x looser in development and tests; production can't be loosened |
| ✅ | Tests: A using up any limit never affects B, even on the same IP; SOS guarantee; `Retry-After` |

## Stage 3 — Admin protection and secrets ✅ (PR #38)

| | Item |
|---|---|
| ✅ | `ADMIN_PHONE_ALLOWLIST`: admin routes, admin login and admin session renewal refuse any number not on it, whatever the database says |
| ✅ | Short admin sessions: 10-minute access token, signed out after 30 idle minutes, 8-hour hard maximum; no long-lived token |
| ✅ | Every admin sign-in attempt recorded (time, IP, device), shown on the admin site's "Admin logins" tab |
| ⬜ | Second factor for admins (authenticator-app code): **approved**, to be built after Stage 6 as its own step — [admin-and-secrets.md](admin-and-secrets.md#proposal-not-built-a-second-factor-for-admins) |
| ✅ | Admin site headers: strict CSP with `frame-ancestors 'none'`, HSTS, noindex and more; tested against the real build in Chrome |
| ✅ | Full git history scanned (gitleaks, 205 commits, 40 branches + project-specific patterns): no secrets; the old prod `.env` backup is gone and was never committed |
| ✅ | Production boot refuses a missing/weak `JWT_SECRET` and any missing required setting (names listed, values never logged) |
| ✅ | Rotation list: every secret, where it's set, how to rotate ([admin-and-secrets.md](admin-and-secrets.md#secrets-to-rotate-before-launch)) |

## Stage 4 — Input validation and error handling ✅ (PR #40)

| | Item |
|---|---|
| ✅ | JSON schema on every route: unlisted fields dropped, every string length-limited, ids, coordinates, choices and numbers checked, no type conversion of bodies; a test fails on any route without one — [validation-and-errors.md](validation-and-errors.md) |
| ✅ | Sign-in checked before the body is looked at (401/403 first, whatever was sent) |
| ✅ | Request body limit 64 KB (413), Socket.io message limit 16 KB |
| ✅ | No stack traces, Prisma or SQL errors to clients, in any environment: one error shape with a plain sentence, a code and a request id; `X-Request-Id` on every response |
| ✅ | No login codes, tokens, push tokens, credentials or full phone numbers in logs (`+233*****146`), including careless future log lines, URLs and error stacks |
| ✅ | Unhandled rejections and exceptions logged (scrubbed), then a clean shutdown and exit 1 |
| ✅ | Graceful shutdown on deploy: in-flight requests finish, sockets and database close, 20 s safety limit |

## Stage 5 — Monitoring 🔶 (branch `security-stage5-monitoring`)

| | Item |
|---|---|
| 🔶 | Sentry in the server, rider app, driver app and admin site; off until a DSN is set (server and admin: Render; apps: EAS environment variables) — [monitoring.md](monitoring.md) |
| 🔶 | One scrubber for every Sentry client: no phone numbers, codes, tokens, request bodies, IPs, screenshots; checked end to end against a fake Sentry |
| 🔶 | Performance sampling 2 in 100; releases tagged (deployed commit; app build plus EAS Update id) |
| 🔶 | Server 500s reported with the request id the user saw; crashes reported before exit |
| 🔶 | `/health/ready` checks the database (3 s, 503 when down) for UptimeRobot; `/health` stays database-free for Render |
| 🔶 | Alerts: every failed SMS; push failures, database connection failures, ride sweep failures and bad-token socket refusals above a threshold |
| 🔶 | Moolre SMS balance checked every 6 hours with a low-balance warning (undocumented Moolre call, so a manual check is documented too) |
| 🔶 | DEPLOY.md, step by step: Sentry projects and where each DSN goes, UptimeRobot switch, Neon compute-hour check, Moolre balance |

## Stage 6 — Backups, recovery and load ⬜

| | Item |
|---|---|
| ⬜ | Backup and restore runbook (weekly Neon branch, limits, optional `pg_dump`) |
| ⬜ | Incident runbook |
| ⬜ | In-memory state document; startup sweep so no ride is stuck after a restart |
| ⬜ | Connection-pool and Render-plan recommendation |
| ⬜ | Local load test with results in plain English |

## Things only you can do by hand

**Now (Stage 5)** — the steps are in
[DEPLOY.md → Monitoring](../../DEPLOY.md#monitoring-sentry-uptimerobot-neon):

1. **Before merging:** publish any over-the-air update still waiting for the
   current app builds. Updates published after this merge reach only new
   builds (Sentry adds native code).
2. Create the four Sentry projects; set `SENTRY_DSN` (server, Render),
   `VITE_SENTRY_DSN` (admin site, Render, then redeploy) and
   `EXPO_PUBLIC_SENTRY_DSN` (each app, expo.dev, plain text, production).
3. Change the admin site's `Content-Security-Policy` header by hand (new
   value in DEPLOY.md), or its reports are blocked.
4. Make new builds of both apps.
5. Switch UptimeRobot to `https://api.campusride.app/health/ready`.
6. Check Neon compute hours weekly: on the free plan they are likely to run
   out around the 17th of each month (DEPLOY.md explains why). Decided in
   Stage 6.
7. Optional: a Sentry auth token for readable app errors.

**Stage 4, after its deploy, if not done yet** — in Render → the server → **Logs**:

1. Around the deploy, the old server should log `"event":"shutdown"` and then
   `"event":"shutdown_complete"`. If you see `"event":"shutdown_timeout"`
   instead, tell me.
2. Search for `+233`: every number should look like `+233*****146`.
3. Leave `LOG_LEVEL` unset (it defaults to `info`).

**Stage 3, if not done yet** — in this order:

1. **Before merging,** on Render → the server → Environment, make sure each of
   these is set (the new version refuses to start without them):
   `ADMIN_PHONE_ALLOWLIST` (your number), `SUPPORT_CONTACT_PHONE`,
   `PUBLIC_BASE_URL` (`https://api.campusride.app`), `CORS_ALLOWED_ORIGINS`
   (the admin site's https address), `JWT_SECRET` (32+ random bytes: if in
   doubt, set a new one with `openssl rand -hex 32` — everyone signs in
   again), `DATABASE_URL`, `DIRECT_URL`, and the Moolre SMS settings.
2. **Before merging,** apply migration
   `apps/server/prisma/migrations/20261015200000_admin_login_audit` to
   production, the same way as the others (it only adds two columns).
3. **After the deploy:** sign in to the admin site, open **Admin logins** and
   check your own sign-in is listed. In Render → `campusride-admin` →
   Settings → Headers, check the security headers are there (add them by hand
   if the site isn't managed from `render.yaml`).
4. **Rotate the secrets** on the list in
   [admin-and-secrets.md](admin-and-secrets.md#secrets-to-rotate-before-launch),
   starting with the Neon production password, `JWT_SECRET` and the Moolre
   SMS key.
5. ~~Clean up `apps/server/.env` on your Mac~~ — done 2026-10-15: it holds
   the development database URLs only.
6. ~~Decide on the admin second factor~~ — approved 2026-10-15; built after
   Stage 6.

**Earlier stages, if not done yet:** Stage 1 — apply migration
`20261015180000_tracking_links` (SOS fails without it). Stage 2 — delete
`TRUST_PROXY` on Render, check the `client_ip_check` log line says
`"resolvedToClient":true`, and publish the apps' over-the-air update.

**Later stages** (details come with each stage)

- [ ] Make a weekly Neon backup branch (`backup-YYYY-MM-DD`) — Stage 6
- [ ] Choose the Render plan (free vs paid) — Stage 6
- [ ] Set up the admin authenticator app (QR code, recovery codes) — after Stage 6
