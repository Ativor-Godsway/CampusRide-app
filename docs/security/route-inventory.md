# Route and socket-event inventory

Every HTTP route and every Socket.io event the server handles: whether it
needs a login, which roles may use it, what it lets a person touch, and how
often. Written for the owner and anyone changing the server.

**This list is checked by a test.** `apps/server/src/routes/authorization.test.ts`
fails if a route exists that is not in these tables, if a row names a route
that no longer exists, or if the **Login** column disagrees with the code. Add
the row in the same change as the route.

Last reviewed: 2026-10-16 (pre-launch hardening, Stages 1–5).

## How to read it

- **Login.** `Yes` = an access token (`Authorization: Bearer …`) for an
  account that still exists. Deleted accounts are refused even with an
  unexpired token. An OTP verification token is not a login: it is refused
  everywhere a login is needed.
- **Roles.** Checked against the account's role **in the database**, not the
  role written into the token, so removing someone's admin role takes effect
  within seconds.
- **Ownership rule.** What the person may touch. When the request names
  someone else's ride, seat or rating, the answer is **404 with the same body
  as for something that doesn't exist**, so trying ids confirms nothing. A
  wrong *role* gets 403 instead: that refuses a kind of request, not someone's
  resource.
- **Input.** Every route checks what it is sent against a schema (no
  unlisted fields, length limits, id and coordinate formats) after the login
  check: [validation-and-errors.md](validation-and-errors.md).
- **Rate limit.** Counted per **person**: the phone number before login,
  the account after. "Account default" is 120 requests a minute per account
  on any signed-in route. "IP backstop" is 1,000 requests per 15 minutes per
  IP address, only on routes nobody is signed in to, and only when the real
  client address is known — high enough that a whole hostel on one Wi-Fi
  never meets it. Every number is a setting; the full list, and how a 429
  looks, is in [rate-limits.md](rate-limits.md). In development and tests the
  limits are 10x looser.

## Public (no login)

| Route | Login | Roles | Ownership rule / what protects it | Rate limit |
|---|---|---|---|---|
| `GET /health` | No | — | Returns `{status, app}` only. Render's liveness check; never touches the database. | none (Render polls it) |
| `GET /health/ready` | No | — | Also checks the database (`SELECT 1`, at most 3 s): `{status, app, database}`, 503 when it can't be reached. No error details. For UptimeRobot. | none (UptimeRobot polls it) |
| `POST /auth/request-otp` | No | — | Sends a code to the phone given. | per number: 1 per 60 s, 5 / 15 min, 10 / 24 h (an admin's number: 3 / 15 min, 6 / 24 h); per IP: 200 codes / 15 min; IP backstop |
| `POST /auth/verify-otp` | No | — | Returns a 5-minute verification token for that phone only. 5 wrong tries burns the code. | per number: 10 / 15 min (an admin's: 5); IP backstop |
| `POST /auth/signup` | No | — | Needs a verification token for the same phone. Role can only be RIDER or DRIVER; a new driver is never approved. | per number: 10 / 15 min (with log-ins); IP backstop |
| `POST /auth/login` | No | — | Needs a verification token for the same phone. Refuses deleted accounts, and ADMIN accounts not on `ADMIN_PHONE_ALLOWLIST`. From the admin site (`X-CampusRide-Client: admin`), only an allowed ADMIN account gets a session. Attempts from the admin site, or about an admin's number, are recorded. | per number: 10 / 15 min (with sign-ups); IP backstop |
| `POST /auth/refresh` | No | — | The refresh token is the credential. One-time use; re-using one revokes that whole login. Refuses deleted accounts. | per login: 10 / 15 min; per account: 30 / 15 min; IP backstop |
| `POST /auth/logout` | No | — | The refresh token is the credential; only that token's own push token is removed. | IP backstop |
| `POST /demo/otp/send` | No | — | Showcase demo only, separate table from real logins. | its own (per phone 1 / min and 5 / day, per IP 10 / hour, all phones 300 / day); IP backstop |
| `POST /demo/otp/verify` | No | — | As above. 5 wrong tries burns the code. | IP backstop |
| `POST /webhooks/moolre` | No | — | **Not registered in production** (payments are off). When on, Moolre's shared secret is the credential, compared in constant time. | IP backstop |
| `POST /ussd/callback` | No | — | **Not registered in production** (`ENABLE_USSD` is off). Has no authentication of its own; must not be switched on until Moolre's gateway IPs or a secret are checked. | per subscriber: 30 / min; IP backstop |
| `GET /track/:token` | No | — | The 32-character random token is the credential. Shows one rider's own SOS trip: their name and stops (place names only), driver name, vehicle and plate, status. Never coordinates, fares, the driver's number or other riders. Works while the ride is going on and for `TRACKING_LINK_TTL_HOURS` (default 24) after it ends, then answers 410. | per link: 120 / 15 min (the page refreshes every 15 s); IP backstop |

## Any signed-in account

Campus reference data. Nobody's personal information.

| Route | Login | Roles | Ownership rule | Rate limit |
|---|---|---|---|---|
| `GET /zones` | Yes | any | Campus zones. | account default |
| `GET /zones/routes` | Yes | any | Precomputed roads between zones. | account default |
| `GET /places` | Yes | any | Campus landmarks. | account default |
| `GET /places/search` | Yes | any | Campus landmarks. | account default |
| `GET /service-area` | Yes | any | The service-area outline. | account default |
| `POST /routes/legs` | Yes | any | Draws a road through points the caller sends; reveals nobody else's position. | 120 / 15 min; account default |

## The caller's own account

Nothing in the request can point these at another person: the account is
always the one in the token.

| Route | Login | Roles | Ownership rule | Rate limit |
|---|---|---|---|---|
| `GET /me` | Yes | any | Own account only. | account default |
| `PATCH /me` | Yes | any | Own name and emergency contact only. Any other field sent (role, phone, ids) is ignored. | 20 / hour; account default |
| `POST /me/deletion-code` | Yes | any | Texts a confirmation code to the account's **own** phone (never a number from the request); answers with it masked. Refused while a ride is active, before any text is sent. | 5 / hour; the login-code limits for that number; account default |
| `DELETE /me` | Yes | any | Own account only, with the code from `/me/deletion-code`. Refused while a ride is active. Hides the account at once (sessions, push tokens, SOS links gone; name and number replaced), keeps what a safety dispute needs out of sight for 90 days, then erases it ([deleteAccount.ts](../../apps/server/src/services/auth/deleteAccount.ts)). Closes the account's open sockets. | 5 / hour; account default |
| `PUT /me/push-token` | Yes | any | Registers this phone's token to the caller (see "Accepted for now"). Rider tokens only for riders, driver tokens only for drivers. | 30 / 15 min; account default |
| `DELETE /me/push-token` | Yes | any | Removes the token only if it is the caller's. | 30 / 15 min; account default |
| `POST /driver/profile` | Yes | DRIVER | Own vehicle details only. A photo must be the driver's own upload. Approval and online status can't be set here. | 20 / hour; account default |
| `PATCH /driver/profile` | Yes | DRIVER | As above. | 20 / hour; account default |
| `PATCH /driver/availability` | Yes | DRIVER | Own online status; going online needs an approved, complete profile. | account default |
| `PATCH /driver/zone` | Yes | DRIVER | Own current zone. | account default |
| `GET /driver/rides/active` | Yes | DRIVER | Own current trip. Riders' phone numbers only for riders still to be picked up or in the car. | account default |
| `GET /driver/rides/history` | Yes | DRIVER | Own completed trips; place names only. | account default |
| `GET /driver/rides/eligible` | Yes | DRIVER | Requests offered to this driver (online, approved, nearby zone, not declined). First names and place names, never pins. | account default |
| `GET /rides/mine` | Yes | RIDER | Own bookings only. | account default |
| `GET /rides/active` | Yes | RIDER | Own current ride (as booker or passenger), own stops only. | account default |
| `POST /rides` | Yes | RIDER | Books for the caller only; one active ride at a time. Rider, driver, status and fares can't be set by the app. | 12 / hour (and one active ride at a time); account default |
| `POST /uploads/driver-photo/signature` | Yes | DRIVER | Signs an upload that can only land at this driver's own image id. | 10 / hour; account default |
| `POST /uploads/driver-photo/failure` | Yes | DRIVER | Logs the driver's own upload error. | account default |

## Someone's ride, seat or rating

The request names a resource. If it isn't the caller's: **404**, same body as
"doesn't exist", nothing changes. Each row has a cross-user case in
`authorization.test.ts`.

| Route | Login | Roles | Ownership rule | Rate limit |
|---|---|---|---|---|
| `GET /rides/:id` | Yes | RIDER | The booking rider or a rider with a seat on it. Other riders' pins are blanked. The driver's number is shown during the trip and for 24 h after it completes; never on a cancelled ride. | account default |
| `POST /rides/:id/decision` | Yes | RIDER | The booking rider only. | account default |
| `POST /rides/:id/cancel` | Yes | RIDER | The booking rider only. If the driver has added other riders to the car, only the booking rider's own seat is cancelled and the car carries on. | 12 / hour; account default |
| `POST /rides/:id/switch` | Yes | RIDER | The booking rider only. | 10 / 15 min; account default |
| `POST /rides/:id/initiate-payment` | Yes | RIDER | The booking rider or a passenger, for their own fare. Answers "cash only" while payments are off. | 15 / 15 min; account default |
| `GET /rides/:id/payment-status` | Yes | RIDER | The booking rider or a passenger; their own payment only. | account default |
| `POST /rides/:id/sos` | Yes | RIDER | Anyone who was on the ride, even if their seat was cancelled: an ownership rule must never block an emergency. The link sent is about the person who pressed SOS. | **never limited**; a repeat press within 2 min doesn't text the same people again |
| `POST /ratings` | Yes | any | A rider who took the completed trip rates its driver, once per trip (sending again corrects it). A rider whose seat was cancelled gets 403. | 20 / hour; account default |
| `POST /ratings/rider` | Yes | DRIVER | The trip's own driver rates a rider who was carried, once per rider per trip. | 20 / hour; account default |
| `GET /rides/:id/rateable-riders` | Yes | DRIVER | The trip's own driver; lists only riders who were carried. | account default |
| `POST /rides/:id/claim` | Yes | DRIVER | An open request (see "Accepted for now"). A trip another driver holds answers 409 "taken" and is not touched. | 60 / 15 min; account default |
| `POST /rides/:id/reject` | Yes | DRIVER | Records only the caller's own decline of an open request. | 120 / 15 min; account default |
| `POST /rides/:id/arrived` | Yes | DRIVER | The trip's own driver. | account default |
| `POST /rides/:id/depart` | Yes | DRIVER | The trip's own driver (nothing about another driver's trip, not even its type, is answered). | account default |
| `POST /rides/:id/complete` | Yes | DRIVER | The trip's own driver. | account default |
| `GET /rides/:id/fill-suggestions` | Yes | DRIVER | The car's own driver. Other open shared requests appear by first name and place name only. | account default |
| `GET /rides/:id/add-preview` | Yes | DRIVER | The car's own driver. The rider being considered is shown by place name, never their pin. | account default |
| `POST /rides/:id/add-passenger` | Yes | DRIVER | The car's own driver. | account default |
| `POST /rides/:id/passengers/:passengerId/arrived` | Yes | DRIVER | The car's own driver, for a seat on that car. | account default |
| `POST /rides/:id/passengers/:passengerId/pickup` | Yes | DRIVER | As above. | account default |
| `POST /rides/:id/passengers/:passengerId/dropoff` | Yes | DRIVER | As above. | account default |
| `POST /rides/:id/passengers/:passengerId/cancel` | Yes | DRIVER | As above. | account default |
| `POST /rides/:id/passengers/:passengerId/no-show` | Yes | DRIVER | As above (older app builds). | account default |

## Admin

Two keys, both needed: the account's role is ADMIN in the database **and**
its phone is on `ADMIN_PHONE_ALLOWLIST` (set on Render). Anyone else gets 403,
riders and unlisted admins alike. Every change writes an `AdminAuditLog` row
in the same transaction. Admin sessions are short: a 10-minute access token
renewed while in use, ended by 30 idle minutes or 8 hours after signing in.
See [admin-and-secrets.md](admin-and-secrets.md).

| Route | Login | Roles | Ownership rule | Rate limit |
|---|---|---|---|---|
| `GET /admin/drivers/pending` | Yes | ADMIN | All drivers awaiting approval. | account default |
| `POST /admin/drivers/:id/approve` | Yes | ADMIN | Any driver; audit-logged. | account default |
| `POST /admin/drivers/:id/reject` | Yes | ADMIN | Any driver; audit-logged; takes them offline. | account default |
| `GET /admin/rides` | Yes | ADMIN | All rides, including pins and phone numbers. | account default |
| `GET /admin/places` | Yes | ADMIN | All places. | account default |
| `POST /admin/places` | Yes | ADMIN | Audit-logged. | account default |
| `PATCH /admin/places/:id` | Yes | ADMIN | Audit-logged. | account default |
| `GET /admin/audit/logins` | Yes | ADMIN | Every attempt to sign in to the admin site, with time, IP and device (for spotting a stranger). | account default |
| `GET /admin/rate-limits` | Yes | ADMIN | A phone number's limits in use (and its account's). Audit-logged. | account default |
| `POST /admin/rate-limits/clear` | Yes | ADMIN | Clears one number's and its account's limits, nobody else's. Audit-logged. | account default |
| `GET /admin/account-deletion` | Yes | ADMIN | The open account on a number (name, role, joined), for an emailed deletion request, and whether it can be deleted now. Audit-logged. | account default |
| `POST /admin/account-deletion/code` | Yes | ADMIN | Texts that number an account-deletion code (valid 30 minutes). Refused for admin accounts and during a ride. Audit-logged. | account default; plus the number's code limits (as `POST /auth/request-otp`) and the per-IP code cap |
| `POST /admin/account-deletion/verify` | Yes | ADMIN | Checks the code the person emailed back; a right one returns a 5-minute token for that account and that admin only. 5 wrong tries burns the code. Audit-logged, never the code. | account default; plus the number's code-check limit |
| `POST /admin/account-deletion/delete` | Yes | ADMIN | Closes that one account with the token, exactly as in-app deletion does. Refused for admin accounts and during a ride. Audit-logged. | account default |

## Socket.io

One connection per app, on the same address as the API. Tested in
`apps/server/src/realtime/rideSocket.integration.test.ts`.

**Handshake.** The app sends its access token. The server refuses the
connection (`connect_error: "unauthorized"`, the same message for every
reason) if the token is missing, invalid, expired, an OTP verification token,
or belongs to a deleted account. Once connected, a socket stays connected
until the app closes it or the account is deleted (deletion closes it at
once). The app reconnects with its newest token, and after a refusal it
refreshes the token and tries again.

On connecting, every account joins its own personal room, and drivers also
join their driver room. Nobody else can join those.

### Events the apps send

| Event | Login | Roles | Ownership rule | Rate limit |
|---|---|---|---|---|
| `ride:subscribe` (ride id) | Yes | any | Joins the ride's room only for: its driver; a rider whose own seat is still live (waiting, at pickup or in the car); the booking rider of an older ride with no seats. A rider who has been dropped off or cancelled stops following the car, and is removed from the room when that happens. Optional acknowledgement `{ok}`: `false` for someone else's ride and for a ride that doesn't exist alike. Malformed ids are ignored. | 60 / min per account (past it: `{ok: false}`) |
| `ride:unsubscribe` (ride id) | Yes | any | Leaves the caller's own socket from that room. | none (no database work) |
| `driver:location` (`{rideId, lat, lng}`) | Yes | DRIVER | Relayed to the ride's room only from that ride's own driver while the trip is active (matched, arrived or under way). Coordinates must be real numbers on the globe. Anything else is dropped silently, without disconnecting. | 1 per 2 s per driver; extras dropped silently |

### Events the server sends

| Event | Sent to | Contains |
|---|---|---|
| `ride:status` | The ride's room | Ride id and status. |
| `ride:driver_assigned` | The ride's room | Driver's name, phone, car, plate, rating, photo. |
| `ride:driver_location` | The ride's room | Driver's position. |
| `ride:completed` | Each carried rider's personal room | That rider's own fare. |
| `ride:passenger_status` | That rider's personal room | That rider's own seat status. |
| `ride:car_notice` | That rider's personal room | "Picking up 1 more rider", for riders in the car. |
| `ride:broadcast` | Driver rooms of the drivers it is offered to | Place names and fare; never pins. |
| `ride:offer_closed` | Driver rooms of the drivers it was offered to | Ride id and why it closed. |

## Accepted for now

Known, deliberate, and small. Each could be tightened later if it matters.

- **Claiming by id.** An online, approved driver can claim any open request
  whose id they have, not only one currently offered to them. Ids are long
  random strings that reach drivers only through offers, and checking the
  offer at claim time would refuse a driver who drove into the next zone
  during the 15-second offer.
- **Fill your car.** A driver with a shared car sees every open shared request
  on campus (first name and place name only) so they can fill seats. That is
  the feature.
- **Push tokens follow the phone.** Registering a push token that another
  account had moves it to the caller (one phone, a new sign-in). Doing it on
  purpose needs the other phone's token, which only that phone has.
- **Corrected ratings.** Sending a rating again for the same trip replaces it.
  There is still only one rating per direction per trip.
- **A few seconds of cache.** Whether an account is open, and its role, is
  cached for 10 seconds. Deleting an account takes effect at once on this
  server. With more than one server instance, the others would notice within
  those 10 seconds.
- **Dormant routes.** `POST /ussd/callback` and `POST /webhooks/moolre` exist
  in the code but are not registered while USSD and payments are off.
