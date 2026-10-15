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

## Stage 3 — Admin protection and secrets 🔶 (branch `security-stage3-admin-secrets`)

| | Item |
|---|---|
| 🔶 | `ADMIN_PHONE_ALLOWLIST`: admin routes, admin login and admin session renewal refuse any number not on it, whatever the database says |
| 🔶 | Short admin sessions: 10-minute access token, signed out after 30 idle minutes, 8-hour hard maximum; no long-lived token |
| 🔶 | Every admin sign-in attempt recorded (time, IP, device), shown on the admin site's "Admin logins" tab |
| ⬜ | Second factor for admins: proposed (authenticator-app code), **waiting for your OK** — [admin-and-secrets.md](admin-and-secrets.md#proposal-not-built-a-second-factor-for-admins) |
| 🔶 | Admin site headers: strict CSP with `frame-ancestors 'none'`, HSTS, noindex and more; tested against the real build in Chrome |
| 🔶 | Full git history scanned (gitleaks, 205 commits, 40 branches + project-specific patterns): no secrets; the old prod `.env` backup is gone and was never committed |
| 🔶 | Production boot refuses a missing/weak `JWT_SECRET` and any missing required setting (names listed, values never logged) |
| 🔶 | Rotation list: every secret, where it's set, how to rotate ([admin-and-secrets.md](admin-and-secrets.md#secrets-to-rotate-before-launch)) |

## Stage 4 — Input validation and error handling ⬜

| | Item |
|---|---|
| ⬜ | JSON schema on every route (no extra fields, length limits, phone/id formats); body and socket payload size limits |
| ⬜ | No stack traces, Prisma or SQL errors to clients in production; request id instead |
| ⬜ | No OTPs, tokens or full phone numbers in logs |
| ⬜ | Unhandled rejections/exceptions logged, then a clean exit |
| ⬜ | Graceful shutdown on deploy |

## Stage 5 — Monitoring ⬜

| | Item |
|---|---|
| ⬜ | Sentry in server, rider, driver and admin (silent without a DSN, scrubbed, low sampling, releases tagged) |
| ⬜ | `/health/ready` with a database check |
| ⬜ | Alerts for failed SMS, failed pushes, DB connection failures, socket auth failures; Moolre balance check |
| ⬜ | DEPLOY.md: Sentry setup, UptimeRobot switch, Neon compute-hour check |

## Stage 6 — Backups, recovery and load ⬜

| | Item |
|---|---|
| ⬜ | Backup and restore runbook (weekly Neon branch, limits, optional `pg_dump`) |
| ⬜ | Incident runbook |
| ⬜ | In-memory state document; startup sweep so no ride is stuck after a restart |
| ⬜ | Connection-pool and Render-plan recommendation |
| ⬜ | Local load test with results in plain English |

## Things only you can do by hand

**Now (Stage 3)** — in this order:

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
5. **Clean up `apps/server/.env` on your Mac:** it holds the production
   database URLs; it should hold development values only.
6. **Decide** on the admin second factor (proposal in admin-and-secrets.md).

**Earlier stages, if not done yet:** Stage 1 — apply migration
`20261015180000_tracking_links` (SOS fails without it). Stage 2 — delete
`TRUST_PROXY` on Render, check the `client_ip_check` log line says
`"resolvedToClient":true`, and publish the apps' over-the-air update.

**Later stages** (details come with each stage)

- [ ] Create the Sentry projects and set each DSN (Render, EAS, admin site) — Stage 5
- [ ] Switch the UptimeRobot monitor to `/health/ready` — Stage 5
- [ ] Make a weekly Neon backup branch (`backup-YYYY-MM-DD`) — Stage 6
- [ ] Choose the Render plan (free vs paid) — Stage 6
