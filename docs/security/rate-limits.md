# Rate limits

How CampusRide stops one person — or one bot — from using up what everyone
else needs, without ever locking out people who share a network. Written for
the owner and anyone changing the server.

## The rule

**Limits count per person, not per network.** Before someone logs in, the
person is their phone number. After, it's their account. On a campus, a whole
hostel on one Wi-Fi or a thousand students on one mobile carrier's address
look like one IP, so an IP is only ever a high backstop against bots, and
only on routes nobody is signed in to. When user A uses up a limit, user B is
never affected, even on the same IP. Tests prove this for every limited route
(`apps/server/src/rateLimit/rateLimit.test.ts`).

**SOS is never refused.**

## Before Stage 2 (2026-10-15)

| What | Counted per | Limit |
|---|---|---|
| Any route without its own limit | IP | 100 / minute |
| Request a login code | IP; phone | 5 / 15 min per IP; 3 / 15 min and 5 / hour per phone (database) |
| Verify a code | IP | 10 / 15 min; 5 wrong tries burn a code |
| Log in / sign up | IP | 10 / 15 min each |
| Token refresh | IP | 30 / 15 min |
| Book a ride | IP | 20 / 15 min |
| Cancel / switch a ride | account | 20 and 10 / 15 min |
| SOS | IP | 20 / 15 min |
| Photo upload ticket | IP | 10 / 15 min |
| Route drawing, push tokens | account | 120 and 30 / 15 min |
| Driver GPS (socket) | — | none |

Counters lived in server memory (the `@fastify/rate-limit` plugin), except the
per-phone code caps, which were counted in the database.

**The flaw.** The server trusted exactly one proxy in front of it
(`TRUST_PROXY=1`). Requests to Render pass through Cloudflare and then
Render's own load balancer, so every request looked like it came from the load
balancer's private address. Every "per-IP" limit was one bucket shared by the
whole app: five login-code requests in 15 minutes from anyone would have
blocked login for everyone. Even with the right IP, a hostel sharing one would
have shared "5 codes per 15 minutes".

## The limits now

Production numbers. Each is an environment variable on Render (change it
there; no code change needed). The time windows are fixed.

### Logging in (per phone number)

| Limit | Default | Variable |
|---|---|---|
| Time between two codes to the same number | 60 s | `RATE_LIMIT_OTP_COOLDOWN_SECONDS` |
| Codes to a number | 5 / 15 min, 10 / 24 h | `RATE_LIMIT_OTP_SEND_15M`, `RATE_LIMIT_OTP_SEND_24H` |
| Code checks on a number | 10 / 15 min (and 5 wrong tries burn a code) | `RATE_LIMIT_OTP_VERIFY_15M` |
| An ADMIN account's number | 3 codes / 15 min, 6 / 24 h, 5 checks / 15 min | `RATE_LIMIT_ADMIN_OTP_*` |
| Log-ins and sign-ups | 10 / 15 min | `RATE_LIMIT_LOGIN_15M` |
| Token refreshes | 10 / 15 min per login, 30 / 15 min per account | `RATE_LIMIT_REFRESH_SESSION_15M`, `RATE_LIMIT_REFRESH_USER_15M` |

The admin limits go by the number, not by which app asked, so the admin
site's tighter limits can't be dodged by logging in through the rider app.

### Signed in (per account)

| Limit | Default | Variable |
|---|---|---|
| Any signed-in request (the default) | 120 / minute | `RATE_LIMIT_USER_PER_MINUTE` |
| Book a ride | 12 / hour (plus one active ride at a time) | `RATE_LIMIT_RIDE_CREATE_HOUR` |
| Cancel a ride | 12 / hour | `RATE_LIMIT_RIDE_CANCEL_HOUR` |
| Switch shared ↔ alone | 10 / 15 min | `RATE_LIMIT_RIDE_SWITCH` |
| Driver accepts | 60 / 15 min | `RATE_LIMIT_DRIVER_ACCEPT_15M` |
| Driver declines (incl. offers timing out) | 120 / 15 min | `RATE_LIMIT_DRIVER_DECLINE_15M` |
| Ratings | 20 / hour | `RATE_LIMIT_RATING_HOUR` |
| Profile and emergency-contact changes | 20 / hour | `RATE_LIMIT_PROFILE_HOUR` |
| Notification sign-ups (push tokens) | 10 / 15 min; `PUT /me/push-token` counts against this one only, not the default above, so an app stuck re-sending its token can't use up the account's allowance | `RATE_LIMIT_PUSH_TOKEN_15M` |
| Photo upload tickets (each allows a Cloudinary write) | 10 / hour | `RATE_LIMIT_UPLOAD_HOUR` |
| Account deletion attempts | 5 / hour | `RATE_LIMIT_ACCOUNT_DELETE_HOUR` |
| Route drawings (each a campus route on our server) | 120 / 15 min | `RATE_LIMIT_ROUTE_LEGS` |
| Payment attempts (each calls Moolre) | 15 / 15 min | `RATE_LIMIT_PAYMENT_INIT` |
| Live-ride subscriptions (socket) | 60 / minute | `RATE_LIMIT_SOCKET_SUBSCRIBE_MINUTE` |
| Driver GPS (socket) | 1 per 2 s per driver; extras dropped silently, never a disconnect | `RATE_LIMIT_DRIVER_LOCATION_SECONDS` |
| Driver position without a trip (socket, for riders' Home map cars) | 1 per 2 s per driver, counted apart from trip GPS; extras dropped silently | `RATE_LIMIT_DRIVER_LOCATION_SECONDS` |
| Home map cars (`GET /rides/nearby-cars`) | 1 / 5 s; counts against this one only, not the default above (the app asks by itself every 10 s) | `RATE_LIMIT_NEARBY_CARS_5S` |
| Admin dashboard: big exports (a CSV of more than 200 rows) | 20 / 15 min per admin | `RATE_LIMIT_ADMIN_EXPORT_15M` |
| Admin dashboard: changes (cash payments and reversals, suspending drivers, marking an SOS handled) | 60 / 15 min per admin | `RATE_LIMIT_ADMIN_WRITE_15M` |
| Admin dashboard: a driver's location trail viewed (one driver, one day each) | 60 / hour per admin | `RATE_LIMIT_ADMIN_TRAIL_HOUR` |

The busiest screen (a driver on a trip) makes about 30 requests a minute, so
the default leaves four times that.

### Everything else

| Limit | Default | Variable |
|---|---|---|
| SOS | **never limited**; a repeat press within 2 minutes of one that reached someone doesn't text the same people again | `RATE_LIMIT_SOS_REPEAT_MINUTES` |
| An SOS tracking page | 120 / 15 min per link (it refreshes every 15 s) | `RATE_LIMIT_TRACK_15M` |
| USSD keypresses (dormant) | 30 / minute per subscriber | `RATE_LIMIT_USSD_MINUTE` |
| **IP backstop**: any route nobody is signed in to, and signed-in routes refused for a missing, junk or forged token (not an expired one, below) | 1,000 / 15 min per IP | `RATE_LIMIT_IP_PUBLIC_15M` |
| Login codes from one IP to any numbers | 200 / 15 min per IP | `RATE_LIMIT_IP_OTP_SEND_15M` |

The second IP limit is about money: without it, one machine could text a
code to every number in Ghana on our SMS credit, 5 per number. 200 per
15 minutes is far more sign-ups than a hostel produces.

**Expired tokens don't count toward the IP backstop.** An access token lasts
30 minutes; a request carrying one of ours that has simply run out (signed
with our secret, an access token's shape, past its expiry) still gets a 401 —
even when the IP is full, so the app knows to refresh — but isn't counted.
A phone sending many of those is a real person's app, stuck or mid-refresh,
and its IP is shared with everyone on the same Wi-Fi or mobile network.
Counting them once let one looping phone use up its IP's allowance, which
`/auth/refresh` and log-in share, and lock the driver app on the same phone
out (2026-10-26). Missing, junk and forged tokens — and other kinds of token,
such as an expired login-code token — still count, expired or not. A refusal
for an expired token costs no database lookup.

When one request meets several limits, either all of them count or none
does, so being turned away by the IP backstop never spends a person's own
allowance. A refused request is never counted, so hammering the button
doesn't make the wait longer.

## What a person sees

Every refusal is HTTP 429 with a `Retry-After` header (in seconds) and:

```json
{ "error": "Too many attempts. Try again in 3 minutes.", "code": "RATE_LIMITED", "retryAfterSeconds": 180 }
```

The rider, driver and admin apps show that sentence wherever a request can be
refused. The code screen has a **Resend code** button that counts down 60
seconds (or however long the server says) instead of letting people tap into
refusals. A refused token refresh never signs anyone out.

A repeat SOS says "SOS already sent: Auntie Akos was sent a link a moment
ago" rather than "couldn't send". If the first press reached nobody, a repeat
tries again.

## The real client IP behind Render

A request travels client → Cloudflare → Render's load balancer → our server,
and each hop adds an address to `X-Forwarded-For`. In production the server
trusts private network addresses and Cloudflare's published ranges, and takes
the first address from the right that is neither: the client. A client can't
fake it, because anything it puts in the header sits to the left of what the
proxies add. Proven in `apps/server/src/lib/security.test.ts`.

**Safety net:** if the address found is still a proxy's or a private one
(Render changes its setup, Cloudflare adds a range), the server skips the IP
backstop instead of putting everyone in one bucket, and warns once in the log
(`client_ip_unresolved`). The per-person limits still apply.

**Check it after deploying.** In Render's Logs, search for `client_ip_check`
(logged once after each start, on the first real request, without any address in it). You want
`"resolvedToClient":true`. If it says `false`, or you see a warning that
`TRUST_PROXY is a hop count`, delete `TRUST_PROXY` from the service's
Environment tab.

## Where the counters live

In the server's memory. That's right for one server instance. A restart (a
deploy, or the free plan sleeping after 15 idle minutes) clears them, which
only ever means someone gets a fresh allowance early.

Every limit goes through one interface, `RateLimitStore` in
`apps/server/src/rateLimit/store.ts`. To run more than one instance, write a
Redis version of it (the four methods are spelled out in that file) and pass
it to `setRateLimitStore` at startup. Nothing else changes.

## Helping someone who is locked out

Admin site → **Rate limits** → type their number. It shows every limit that
number (and its account) is using, which are blocked, and when each resets.
**Clear this number's limits** resets them all, for that person only. Both
looking and clearing are recorded in the admin audit log.

## Development and tests

Outside production every maximum is 10 times higher (`RATE_LIMIT_MULTIPLIER`),
so local work and the test suite never trip a limit by accident. A
development server doesn't limit requests from the Mac itself at all (for the
simulator). Production ignores both and always uses the numbers above.

## Known trade-off

Counting per number means someone who knows a person's number can use up
that number's login codes on purpose (5 per 15 minutes, 10 per day), and
that person then can't get a code until the window passes. They would need
the victim's number, and every attempt costs them the IP limits above. The
fix for the victim is the admin screen: clear the number and they can log in
straight away. Per-IP limits would avoid this, but would lock out whole
hostels instead, which is worse.
