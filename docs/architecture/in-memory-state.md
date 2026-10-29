# What the server keeps only in memory

Everything the CampusRide server holds in its own memory rather than in the
database: what happens to it when the server restarts or a deploy replaces
it, and what would break if two or more servers ran at once. Pre-launch
hardening, Stage 6 (2026-10-16). For whoever changes the server or its
hosting.

## The short version

- **A restart or deploy can't leave a ride stuck.** Every ride's state and
  timing lives in the database. The timeout sweep reads it from there, runs
  once at startup and then every 30 seconds.
- **A ride a driver leaves in progress is completed after 3 hours**
  (`RIDE_AUTO_COMPLETE_HOURS`), so its riders can book again. Before this,
  once a ride was in progress only the driver could end it, so a dead phone
  or a forgotten tap locked the riders out for good
  (`apps/server/src/services/ride/staleRides.ts`).
- **What a restart loses is harmless:** rate-limit counts start again,
  caches refill, every app reconnects its live connection within seconds.
- **One server only, for now.** Running two needs three things first:
  rate limits in Redis, a Socket.io Redis adapter (and sticky sessions), and
  a single owner for the background jobs. See the last section.

## How a restart or deploy goes

1. Render starts the new server. It connects to the database, **sweeps for
   timed-out rides at once**, and starts taking requests.
2. About a minute later Render sends the old server SIGTERM. It finishes its
   in-flight requests, closes every live connection (Socket.io), closes the
   database and exits (`lib/shutdown.ts`).
3. The apps reconnect to the new server, refreshing their sign-in if needed,
   and **rejoin the ride they're watching** (the app re-sends the join on
   every reconnect: `packages/mobile-shared/src/realtime/socket.ts`).
   Ride screens also re-read the ride every 12 seconds, so a status change
   is never missed for long.
4. Drivers stay online: being online is stored in the database, not tied to
   the connection.

## The inventory

| State | Where | On restart or deploy | With 2+ servers |
|---|---|---|---|
| **Rate-limit counts**: codes, sign-ins, bookings, the per-IP backstop, driver GPS throttling, SOS repeat texts | `rateLimit/store.ts` (`MemoryRateLimitStore`, behind the `RateLimitStore` interface) | Reset: everyone starts with fresh limits. Someone mid-lockout can try again early. | **Breaks**: each server counts on its own, so every limit is N times looser. Needs a Redis store (the interface is ready: [rate-limits.md](../security/rate-limits.md)). |
| **Live connections and rooms** (Socket.io): who is connected, who is in which ride's room, each driver's and rider's personal room | `realtime/rideSocket.ts` | All connections close (cleanly, step 2). Apps reconnect and rejoin within seconds; drivers rejoin their room automatically. A location ping sent during the gap is lost; the next one, 3 s later, isn't. | **Breaks**: an event sent by one server doesn't reach a phone connected to another (a ride offer, "driver arrived", live location). Needs `@socket.io/redis-adapter`, plus sticky sessions for the polling fallback. |
| **Ride timing**: request windows, the rider's decision time, rides left in progress | Database (`broadcastStartedAt`, `decisionStartedAt`, `departedAt`); `services/ride/timeouts.ts` | Nothing lost. The startup sweep settles anything that ran out while the server was down; nothing waits for a timer in memory. | Works, with duplicates: every server sweeps. Transitions are transactional, so a ride moves once and the other server's attempt fails harmlessly; a completion's fare summary could be sent twice (harmless). Better to sweep on one server only. |
| **Ride offers to drivers** | Database (declines in `RideRejection`); the 15-second countdown runs in the driver app | Nothing lost. | Works, given the Socket.io adapter above. |
| **Account check cache**: whether an account still exists and its role, 10 seconds | `services/auth/accountStatus.ts` | Empty; refilled on the next request. | Works: each server caches separately, each at most 10 s stale. |
| **Zones and places cache**, 60 seconds | `services/zones/zoneCache.ts`, `services/places/placeCache.ts` | Empty; refilled on first use. | Works: an admin's place edit shows up on each server within 60 s. |
| **Route cache** (campus routes), up to 1,000, and the campus road graph | `services/routing/campusRoutes.ts` | Empty: the first trips after a restart are routed again (a few ms each; the graph builds in ~10 ms). | Works: each server routes on its own copy of the graph. |
| **Push dedupe**: "don't send the same notification twice within a few minutes" | `services/push/rateLimit.ts` | Forgotten: one notification already sent just before the restart (say, "driver arriving") could be sent once more. | A notification triggered on two servers could arrive twice. Move to Redis with the rate limits. |
| **Push receipts waiting to be checked**, about 15 minutes after each send | `services/push/pushService.ts` (`pendingReceipts`) | Lost: delivery results for the last ~15 minutes' pushes aren't checked. Dead tokens among them are still removed the next time a push to them fails. | Works: each server checks its own sends. |
| **"Driver arriving" check spacing**, 15 seconds per ride | `services/push/notify.ts` | Forgotten: one extra check, no extra notification (the push dedupe and the database decide that). | Works. |
| **SOS: was the last alert delivered?** For the repeat-press message | `services/safety/sos.ts` (`recentAlerts`) | Forgotten: a second SOS press shortly after a restart sends the alert again rather than saying "already sent". Safe direction. | Same, if the presses reach different servers. |
| **USSD menu sessions** | `services/ussd/session.ts` | Lost: someone mid-menu has to dial again. (USSD is switched off in production.) | **Breaks**: the next step of a menu may reach a server that doesn't know the session. Needs a shared store before USSD is switched on with 2+ servers. |
| **Alert counters**: "10 push failures in 15 minutes" and the like | `lib/alerts.ts` | Reset: an ongoing problem is counted again from zero (it reports again a little later). | Each server counts its own: alerts fire later than intended. |
| **Repeating jobs**: timeout sweep (30 s), push receipts (5 min), Moolre balance (6 h) | `index.ts` | Restarted. The timeout sweep runs straight away at startup. | Every server runs them: duplicate balance warnings, double sweeping (see "Ride timing"). Run them on one server only. |
| **Error reporting queue** (Sentry) | `lib/monitoring.ts` | Flushed during the clean shutdown; anything after a hard kill (SIGKILL) is lost. | Works. |

Things that are **not** in memory, despite how they might look: driver online
status, admin sessions and their idle timeout, sign-in tokens, login codes,
SOS tracking links, demo login codes, payments. All in the database.

## Running two or more servers

Not needed for the pilot (see [the load test](../runbooks/load-test.md)), but
if it ever is:

1. **Rate limits → Redis.** Write a `RedisRateLimitStore` for the existing
   interface; move the push dedupe and the SOS memory with it.
2. **Socket.io → Redis adapter** (`@socket.io/redis-adapter`), and sticky
   sessions or WebSocket-only connections (the polling fallback needs every
   request of a connection to reach the same server).
3. **Background jobs → one server.** Elect one with a Postgres advisory lock
   (`pg_try_advisory_lock`) at each run, or move them to a Render cron job.
4. **USSD sessions → Redis**, before USSD is switched on.
