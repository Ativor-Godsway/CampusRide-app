# Load test: how much one server can take

Pre-launch hardening, Stage 6 (2026-10-16). Local only: a laptop, a local
database, simulated phones. Never production.

## In plain English

**One server process handled about 750 very busy riders at once without
slowing down at all, and about 1,250 before answers took more than half a
second**, on a 2019 four-core laptop. Past that, nothing failed: requests
waited longer and longer.

**What gives out first is CPU**, long before memory or the database
connections. So on Render, **the instance size decides how many riders the
server can take**:

| Render instance | CPU | Very busy riders (this test) | People with the app open (estimate) | Verdict |
|---|---|---|---|---|
| Free | 0.1 | ~25–30 | ~80 | Testing only: every request is slowed by the tiny CPU share, it sleeps after 15 idle minutes, and Render may restart it any time |
| Starter, $7/month | 0.5 | ~140 | ~400 | **Enough for the pilot** |
| Standard, $25/month | 1 | ~280 | ~800 | When the pilot grows |
| Pro, $85/month | 2 | ~550 | ~1,600 | Well beyond a campus pilot |

The "very busy riders" here request a ride every 25 seconds or so. Real
riders mostly have the app open and idle, polling every 12–15 seconds while
a ride is on, so the "people with the app open" column divides the load by
about three. The Render figures assume one Render CPU does about 70% of the
work of one of this laptop's cores (prices: render.com/pricing, checked
2026-10-16).

**Two problems found and fixed on the way:**

1. **A missing database index.** "Does this rider already have a ride?" runs
   on every booking and on every rider app's poll every 15 seconds, and it
   read the whole passenger table each time: 10 ms with 33,000 rides, and
   growing with every ride ever taken. With the index it takes 0.4 ms
   whatever the history (migration `20261016120000_ride_passenger_rider_index`).
   Without it, a few months of real rides would have slowed every booking.
2. **Every database query was logged in production.** A log line per query:
   about a sixth of the server's processing time under load, and most of
   Render's log volume (157 MB in one nine-minute test). Now only on a
   developer's machine (`PRISMA_QUERY_LOG=true` turns it on anywhere).

## Results

Production's database pool (`connection_limit=5`), 50 drivers on trips
throughout, 60 seconds per stage, after both fixes, with 33,000 rides
already in the database (months of real use):

| Riders | Requests/s | Median | 95th percentile | 99th | Errors | Driver position delay (95th) | Server CPU | Server memory | Database CPU |
|---|---|---|---|---|---|---|---|---|---|
| 200 | 50 | 8 ms | 17 ms | 40 ms | 0% | 1 ms | 78% | 262 MB | 17% |
| 400 | 88 | 8 ms | 16 ms | 24 ms | 0% | 1 ms | 108% | 283 MB | 27% |
| 750 | 162 | 7 ms | 17 ms | 26 ms | 0% | 1 ms | 186% | 309 MB | 51% |
| 1,000 | 204 | 16 ms | 389 ms | 617 ms | 0% | 3 ms | 307% | 323 MB | 81% |
| 1,250 | 238 | 309 ms | 701 ms | 882 ms | 0% | 1 ms | 393% | 449 MB | 105% |
| 1,500 | 228 | 1.5 s | 3.0 s | 3.3 s | 0% | 1 ms | 397% | 528 MB | 100% |
| 2,000 | 239 | 3.2 s | 6.5 s | 6.8 s | 0% | 1 ms | 396% | 627 MB | 104% |

(CPU is a share of one core: 100% = one core busy. The server uses more than
one core because the database client does its work in its own threads.)

**Reading it:**

- **Up to 750 riders nothing changes.** Every kind of request, sign-up
  included, answers in under 25 ms for 95% of people.
- **From about 1,000 the laptop is out of CPU** (server, database and the
  test itself together), requests queue, and the server tops out at about
  235 requests a second. Requests that don't touch the database stay fast
  (`/health` under 65 ms even at 2,000), so the server never stalls; the
  database work is what queues.
- **Driver positions are never late:** relayed to the rider within a few
  milliseconds at every stage.
- **Memory:** about 300 MB at normal load, past 512 MB (the Free and Starter
  limit) only around 1,500 connected riders, far above where their CPU runs
  out.
- **A rush hurts more than a crowd.** In an earlier run (before the two
  fixes), a thousand people signing up within 20 seconds slowed that minute
  down (95th percentile ~6 s), while a thousand riders arriving gradually
  were fine. On Starter the same holds at about a seventh of the numbers.
- **The server's processing cost** is about 1.15% of a laptop core per
  request per second; the database's about 0.3%.

### Database connections: 5 or 10?

The same stages with `connection_limit=10`:

| Riders | 95th percentile, 5 connections | 95th percentile, 10 connections | Most requests/s, 5 / 10 |
|---|---|---|---|
| 750 | 17 ms | 52 ms* | |
| 1,000 | 389 ms | 165 ms | |
| 1,250 | 701 ms | 1,381 ms | 238 / 223 |
| 1,500 | 3.0 s | 3.5 s | |

\* The 10-connection run started at 750 riders, all signing in within 20
seconds; the 5-connection run reached 750 gradually.

More connections don't raise the ceiling: the server tops out at the same
~230 requests a second either way, because the CPU is what runs out. Five is
right.

## Recommendations

**Render: move to Starter ($7/month) before launch.** Free is fine for
testing, but its 0.1 CPU slows every request even when it's quiet, it sleeps
after 15 minutes without traffic (the first rider then waits up to a
minute, unless UptimeRobot keeps it awake), and Render may restart it at any
time. Starter handles the pilot comfortably. **Move to Standard ($25/month)
when** the server's CPU in Render → Metrics regularly passes ~70% at peak
hours, or Sentry's performance view shows typical requests getting slower
(over ~300 ms), or more than about 100 rides are in progress at the same
time.

**Neon: a paid plan before launch**, for compute hours rather than speed
(DEPLOY.md, "Neon: check compute hours every week"): the free plan's 100
hours a month run out mid-month because the server keeps the database awake.
At the database's smallest size the pilot's load is light for it (here the
database used about a third of what the server did).

**Database connections: keep `connection_limit=5`** for Free, Starter and
Standard. CPU runs out long before five connections do, and Neon's pooler
has plenty to spare. **Raise it to 10** on Pro (2 CPUs) or if Sentry ever
shows "Timed out fetching a new connection" (alert `database_connection`).

**One instance is enough.** Running two needs Redis first
([in-memory-state.md](../architecture/in-memory-state.md#running-two-or-more-servers)),
and one Standard instance outlasts a campus pilot.

## What this test doesn't cover

- **Neon's network and compute.** The database here is on the same laptop:
  no network between server and database, and a full laptop core. On Render
  with Neon in the same region (Frankfurt), each database round trip adds a
  millisecond or two, so requests take a few milliseconds longer; the CPU
  each request costs the server is the same.
- **Push notifications, SMS and map routing** are switched off in this
  setup. They run in the background and wait on other services far more
  than they use CPU.
- **Real phones on mobile networks:** slower connections hold sockets open
  longer, which costs memory, not CPU.


## How it was tested

- **Where:** this Mac (Intel MacBook Pro, Node 24), against a **local**
  Postgres database made for the test (`rida_load`). Never production.
- **The server:** the real production build (`npm run build:server`),
  started the way Render starts it, with production's database pool
  (`connection_limit=5`) and normal logging. Push notifications, SMS and the
  map routing service are off in this setup, so their cost isn't included.
- **Drivers:** 50, each on a trip, sending their position every 3 seconds
  over the live connection (Socket.io). Each trip's rider is connected and
  receives it; the delay is measured. Each driver's app also re-reads its
  trip every 15 seconds.
- **Riders:** added in stages (200, 300, 400…). Each one signs in through the
  real login routes (code, verify, sign up; the server accepts a fixed code
  only in this local setup), keeps a live connection, and then repeats:
  request a ride, wait 4–10 s, look at it, wait 2–6 s, check their active
  ride, cancel, pause 5–15 s. That's a ride request every 25 seconds or so
  per rider, far busier than real riders, so "300 riders" here is more like
  1,000 people with the app open.
- **Each simulated phone has its own address** (in `X-Forwarded-For`, as
  Render's proxies send it), so the per-person and per-IP limits behave as
  they would in production.
- **Measured:** response times (median, 95th and 99th percentile), errors
  (no answer, or a 5xx), refusals (any non-2xx, per request kind), the
  driver-position relay delay, and the server's CPU and memory.

## Running it again

```bash
# Once: a local database for the test
createdb rida_load          # with the local Postgres from docs/environments.md
cd apps/server
DATABASE_URL="postgresql://…localhost…/rida_load" DIRECT_URL="$DATABASE_URL" NODE_ENV=test npx prisma migrate deploy
DATABASE_URL="postgresql://…localhost…/rida_load" NODE_ENV=test SEED_ZONE_ADJACENCY=true npx ts-node -r tsconfig-paths/register prisma/seed.ts

# Each time
cd ../.. && npm run build:server
npm run loadtest --workspace=apps/server -- --stages=200,300,400,500 --stage-seconds=60
```

Options: `--pool=10` (database connections), `--profile` (a CPU profile of
the server, opened in Chrome DevTools → Performance), `--max-riders=…`. The
script refuses to run unless the database in `.env.test` is on this machine.
Afterwards, `dropdb rida_load` removes everything it created.
