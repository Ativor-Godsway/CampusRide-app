# Pre-launch security & reliability checklist

Every item of the six-stage hardening pass, and what only the owner can do.
Updated at the end of each stage.

✅ done · 🔶 done on a branch, waiting for merge · ⬜ not done

## Stage 1 — Permissions 🔶 (branch `security-stage1-authorization`)

| | Item |
|---|---|
| 🔶 | Inventory of every HTTP route and Socket.io event: [route-inventory.md](route-inventory.md), checked against the code by a test |
| 🔶 | Ownership enforced on every route; someone else's ride, seat or rating answers 404, same as one that doesn't exist |
| 🔶 | OTP verification tokens can no longer be used as a login (they could watch other people's shared rides live) |
| 🔶 | Roles come from the database, not the token; deleted accounts are refused even with an unexpired token |
| 🔶 | Socket.io: token checked at the handshake; ride rooms only for the driver and riders still in the car; driver positions only from the ride's own driver; every payload validated |
| 🔶 | Mass assignment: every write takes only allow-listed fields (role, approval, online status, fares, other people's ids can't be set), proven by tests |
| 🔶 | A rider cancelling a shared car takes only themselves out; others keep their ride |
| 🔶 | Ratings only between people who actually took the trip |
| 🔶 | SOS links are per rider, show only that rider, and expire 24 h after the ride ends (`TRACKING_LINK_TTL_HOURS`) |
| 🔶 | Contact numbers stop with the trip: no driver number on a cancelled ride; no rider number once they've left the car |
| 🔶 | Table-driven cross-user tests for every route and socket event (rider vs rider, driver vs driver, rider vs admin) |

## Stage 2 — Per-person rate limiting ⬜

| | Item |
|---|---|
| ⬜ | Report of the current limits (key, numbers, store) |
| ⬜ | Limits keyed to the person (phone for OTP, user id when signed in, token for `/track`), IP only as a generous backstop |
| ⬜ | `trustProxy` proven by a test to give the real client IP behind Render |
| ⬜ | Limits on every costly route; SOS never blocks a first alert; driver location throttled, not disconnected |
| ⬜ | 429s carry `Retry-After` and `retryAfterSeconds`; apps show "Try again in X minutes" and a 60 s resend countdown |
| ⬜ | One store interface (in-memory now, Redis-ready), documented |
| ⬜ | Admin lookup and reset of a phone's limits, audit-logged |
| ⬜ | Looser limits in development/test only |
| ⬜ | Tests: user A hitting a limit never affects user B, even on the same IP; SOS guarantee; `Retry-After` |

## Stage 3 — Admin protection and secrets ⬜

| | Item |
|---|---|
| ⬜ | `ADMIN_PHONE_ALLOWLIST` enforced on admin login and routes |
| ⬜ | Short admin sessions with a hard maximum |
| ⬜ | Every admin login logged; "Recent admin logins" view |
| ⬜ | Second-factor proposal for admins (build only after your OK) |
| ⬜ | Admin site security headers |
| ⬜ | Full git-history secret scan; old prod `.env` backup removed; boot refuses weak/missing production secrets; rotation list |

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

**Now (Stage 1)**

1. **Before merging the Stage 1 PR,** apply migration
   `apps/server/prisma/migrations/20261015180000_tracking_links` to production,
   the same way you apply other migrations. It only adds a table, so it is
   safe to apply while the current server is running. If the new server
   starts without it, SOS fails.
2. **After merging,** if any rider or driver build is installed on phones,
   publish an over-the-air update for both apps
   ([releasing.md](../runbooks/releasing.md)): `bash scripts/eas-update.sh rider production "…"`,
   then the same for `driver`. JavaScript only, so OTA is fine.
3. Optional: set `TRACKING_LINK_TTL_HOURS` on Render if 24 hours is not right.

**Later stages** (details come with each stage)

- [ ] Create the Sentry projects and set each DSN (Render, EAS, admin site) — Stage 5
- [ ] Switch the UptimeRobot monitor to `/health/ready` — Stage 5
- [ ] Set `ADMIN_PHONE_ALLOWLIST` on Render — Stage 3
- [ ] Rotate the secrets on the Stage 3 list — Stage 3
- [ ] Make a weekly Neon backup branch (`backup-YYYY-MM-DD`) — Stage 6
- [ ] Choose the Render plan (free vs paid) — Stage 6
