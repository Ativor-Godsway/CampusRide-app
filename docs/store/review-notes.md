# Review demo: notes for App Store and Google Play reviewers

Reviewers can't receive a Ghanaian SMS or stand on campus, so CampusRide has
a review demo: two phone numbers that sign in with a fixed code (no SMS),
and simulated people who make every screen reachable from anywhere in the
world. This page has the text to paste into App Store Connect and Play
Console, and the setup for the owner. Added 2026-10-16.

## What a reviewer gets

**Rider app**, signed in with the demo rider number:

- The app treats them as on campus, wherever they are: "Current location" is
  a campus spot, and they can search campus places or drop a pin on the
  campus map.
- When they request a ride, a simulated driver ("Kwame (demo driver)",
  Toyota Corolla, DEMO 002) accepts within seconds, drives the real road
  route to the pickup on the live map, arrives, starts the trip, drives to
  the drop-off and completes it, about a minute in all. Every screen of a
  trip appears: searching, driver assigned, driver arriving, driver here,
  on the trip, trip complete, rating. Cancelling at any point works too.
- SOS works as for anyone, but nobody is texted.

**Driver app**, signed in with the demo driver number:

- The account is already approved, with a car, so no sign-up or approval.
- Flipping **Online** shows the location explanation and permission prompts
  (as for every driver), and then about once a minute a simulated rider
  ("Ama (demo rider)") requests a ride. The reviewer can accept it and go
  through the whole trip: arrived, picked up, dropped off, rating.

**Kept apart from real people.** Demo rides are flagged: real drivers never
see or receive them, demo drivers never get real requests, real riders are
never matched with demo drivers, and the admin site leaves them out of its
lists and figures. The per-number limits still apply to the demo numbers
(one code a minute, and so on).

## Setting it up (owner, once per review)

1. **Choose two Ghana numbers you control** (spare SIMs are ideal), one for
   the rider demo and one for the driver demo. Don't use your own everyday
   number, or one on `ADMIN_PHONE_ALLOWLIST` (the demo refuses those), or a
   number someone else may own: while the demo is on, that number signs in
   with the fixed code instead of an SMS. If a real CampusRide account
   already has one of the numbers, the demo stays off for it (and Sentry
   says so).
2. **Choose a 6-digit code** for both, not an obvious one like 123456.
3. **Render → `campusride-server` → Environment:**

   | Setting | Value |
   |---|---|
   | `REVIEW_DEMO_RIDER_PHONE` | the rider demo number, e.g. `0240000001` |
   | `REVIEW_DEMO_DRIVER_PHONE` | the driver demo number |
   | `REVIEW_DEMO_OTP` | the 6-digit code |
   | `REVIEW_DEMO_ENABLED` | `true` |

   Save; the server restarts. The logs say `Review demo is ON`; if a
   setting is wrong they say `Review demo is off: …` and why (names only).
4. **Try it once** in both apps before submitting.
5. **When review is done**, set `REVIEW_DEMO_ENABLED=false` (the kill
   switch): the numbers go back to being ordinary numbers that get an SMS,
   and every simulation stops. Turn it on again for the next review.

## App Store Connect → App Review Information

**Sign-in required:** yes. Fill in:

- **User name:** the demo number, e.g. `024 000 0001` (rider app) /
  `024 000 0002` (driver app)
- **Password:** the 6-digit code

**Notes (rider app):**

> CampusRide is a ride-hailing service for one university campus in Ghana.
> Sign-in is by phone number with a one-time code; for review, use the demo
> account below. Tap "Log in", enter the phone number exactly as given, then
> enter the code. No SMS is sent to this number; the code is fixed.
>
> Phone: [REVIEW_DEMO_RIDER_PHONE]  Code: [REVIEW_DEMO_OTP]
>
> The demo account is treated as being on campus wherever you are. Choose a
> drop-off (search, e.g. "Library", or "Choose on map"), pick a ride type and
> request. A simulated driver accepts within seconds and completes the trip
> in about a minute, so every screen can be seen; you can also cancel. SOS
> in the demo doesn't text anyone. Account → Delete account is available
> (the demo account is re-created automatically for the next review).

**Notes (driver app):**

> CampusRide Driver is the driver app of a ride-hailing service for one
> university campus in Ghana. Sign-in is by phone number with a one-time
> code; for review, use the demo account below. Tap "Log in", enter the phone
> number exactly as given, then enter the code. No SMS is sent; the code is
> fixed. The demo driver is already approved.
>
> Phone: [REVIEW_DEMO_DRIVER_PHONE]  Code: [REVIEW_DEMO_OTP]
>
> Flip "Online" on Home. You'll see why location is needed, then the
> location permission prompts. Background location is used only while the
> driver is online, to share their position with the rider on the trip and to
> match them with nearby requests; it stops when they go offline. While
> online, a simulated rider requests a ride about once a minute: accept it,
> then use the trip screen to mark arrival, pick-up and drop-off.

## Google Play Console → App content → App access

Choose **All or some functionality is restricted**, then **Add new
instructions**, once per app:

- **Name:** Demo rider (rider app) / Demo driver (driver app)
- **Username / phone:** the demo number
- **Password / code:** the 6-digit code
- **Any other information:** the same notes as for Apple above (they fit
  the field), adding for the driver app: "The location permission screens
  and the 'You're online' notification are shown in the video linked in the
  Location permissions declaration."

## Things to know

- **Restarts:** a demo trip in progress when the server restarts carries on
  from where it was.
- **Two reviewers at once** on the same demo rider account share it: the
  simulated driver serves one ride at a time, as with any rider.
- **The demo numbers keep the normal limits:** a reviewer who asks for a code
  twice within a minute is told to wait, like anyone.
- **Turn it off after review.** Leaving it on is safe (demo rides never
  touch real people) but there is no reason to keep fixed codes working.
