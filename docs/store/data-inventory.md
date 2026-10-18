# Data inventory

Every piece of personal data the CampusRide rider app, driver app, server,
admin site and website collect: what it is, why, where it is stored, who
receives it, and how long it is kept. Built from the code on 2026-10-16
(main at `b161029`). It is the source for the website's
[privacy policy](../../apps/web/src/pages/privacy.html) and for the Google
Play **Data safety** form and Apple's **App Privacy** answers (last section).

Written for the owner. When the code changes what it collects, update this
file, then the privacy policy.

## Where everything is stored

| System | What | Region |
|---|---|---|
| **Neon** (Postgres) | The database: every table below | EU, Frankfurt (`eu-central-1`), production branch `main` |
| **Render** web service `campusride-server` | The API at `https://api.campusride.app`; request logs; short-lived memory (live locations, rate-limit counters) | EU, Frankfurt |
| **Render** static site `campusride-admin` | Admin site code only. Holds no data: every admin screen reads from the API | US, Oregon |
| **Render** static site `campusride-web` | This website. Collects nothing: no forms, cookies, analytics or scripts | Render's CDN |
| **Sentry** | Crash and error reports from the server, both apps and the admin site, scrubbed | EU, Frankfurt (`*.ingest.de.sentry.io`) |
| **Cloudinary** | Driver profile photos | Cloudinary's storage for the account (US-based company; check the account's region) |

## Personal data, field by field

### Account (riders and drivers)

| Data | Where in the code | Required? | Why | Who sees it |
|---|---|---|---|---|
| **Phone number** (stored as `+233…`) | `User.phone` | Yes: it is the login | Sign-in by texted code; drivers and riders call each other on a trip; SOS page lets the emergency contact call the rider | The person; the other side of their trip (driver ↔ rider); the rider's emergency contact via the SOS page; admins |
| **Name** | `User.name` | Yes | Shown to the other side of a trip; push messages ("Kofi is at your pickup") | Same as above |
| **Role** (rider / driver / admin) | `User.role` | Set by the app used | Which app and features apply | Admins |
| **Emergency contact name and phone** (another person's data, entered by the rider) | `User.emergencyContactName`, `User.emergencyContactPhone` | No | Texted a tracking link when the rider presses SOS | The rider; Moolre (SMS); admins |
| **18+ and terms confirmation**: when "I'm 18 or older and I agree to the Terms and Privacy Policy" was ticked, and which terms version (`TERMS_VERSION` in `@rida/shared`, the pages' "Last updated" date) | `User.ageConfirmedAt`, `termsAcceptedAt`, `termsVersion` (added 2026-10-18) | Yes: `POST /auth/signup` refuses without it; accounts from before are asked once in the app (`POST /me/terms`); review demo accounts are pre-confirmed | A record that the person said they're an adult and agreed to the terms | The person (in `/me`); admins (database) |
| Account created / updated / deleted times | `User.createdAt`, `updatedAt`, `deletedAt` | Automatic | Records | Admins |

No email address, date of birth, ID document, gender or address is collected.
Age is **self-declared** with the sign-up tick (18 or older); no date of birth
or ID is asked for. The confirmation stays on the account row after deletion,
which by then carries no name or number.

### Driver profile (drivers only)

| Data | Where | Required? | Why | Who sees it |
|---|---|---|---|---|
| Car make, model, colour | `Driver.carMake`, `carModel`, `carColor` | Yes, to be approved | Riders recognise the car | Riders on their trips; emergency contacts via the SOS page; admins |
| Number plate | `Driver.plate` | Yes, to be approved | As above; in the SOS text | As above |
| **Profile photo** (camera or photo library, `expo-image-picker`) | Uploaded straight from the phone to **Cloudinary** with a short-lived signature from the server; URL in `Driver.photoUrl` | Yes, to be approved | Riders recognise the driver; approval | Riders on their trips; admins; anyone holding the image URL |
| Approved, online, current zone | `Driver.isApproved`, `isOnline`, `currentZoneId` | Automatic | Dispatch | Admins |

### Location

| Data | App | When | Where it goes | Kept? |
|---|---|---|---|---|
| **Rider's current position** | Rider (foreground only, "while using the app"; background location is switched off in `apps/rider/app.json`) | While the rider is choosing a pickup | Used **on the phone** to suggest the nearest pickup point and show the blue dot. Not sent to the server on its own | No |
| **Rider's exact pickup and drop-off points** ("pins"), their place label and an optional pickup note (≤140 chars) | Rider | When booking | Stored with the ride: `Ride.pickupLat/Lng`, `dropoffLat/Lng`, `pickupLabel`, `dropoffLabel`, `pickupPlaceId`, `dropoffPlaceId`, `pickupNote`, and the same on `RidePassenger` | Yes: with the ride; erased 90 days after account deletion |
| **Driver's position while online**, including **in the background** (`apps/driver/lib/backgroundLocation.ts`: about every 5 s / 10 m, Android foreground service with a "You're online" notification, iOS blue indicator). Only with the driver's permission, after a full-screen disclosure | Driver | From "go online" until offline, sign-out, or the app is swiped away | (a) On the phone: works out which campus **zone** the driver is in; only the **zone id** is sent (`PATCH /driver/zone`, at most every 30 s) and stored as `Driver.currentZoneId`. (b) **During a trip** (matched → finished): the position is sent over the live connection about every 4 s and **relayed straight to the riders on that trip** (`realtime/rideSocket.ts`), and used for the "driver almost there" check. **Not written to the database**; dropped from memory after relaying | No (zone only) |
| Points for drawing road routes (trip pins, driver's position and the stops ahead), rounded to 4 decimals (~11 m) | Both | When a route is drawn | Server → **OSRM** public routing server (`router.project-osrm.org`, run by FOSSGIS e.V., Germany) unless `OSRM_BASE_URL` points elsewhere. Sent by the server, so OSRM sees the server's address, not the user's. Cached in `PointRoute` keyed by the rounded points, with **no user or ride id** | Cache kept indefinitely, not linked to anyone |
| Map display | Both | While a map is on screen | `react-native-maps` with the platform default: **Google Maps** on Android, **Apple Maps** on iOS. The phone loads map tiles from them under their own terms | By Google / Apple |

### Trips and activity

| Data | Where | Why | Who sees it | Kept |
|---|---|---|---|---|
| Rides: pickup/drop-off zone, shared or private, seats, status, times (requested, departed, completed), fare, driver's share, cash/MoMo, why it was cancelled | `Ride`, `RidePassenger` | The service; the business's records; disputes | The rider (their own), the driver (their trips), admins | Indefinitely, without a name after account deletion |
| Rider's cancel reason and optional note (≤200 chars) | `Ride.riderCancelReason`, `riderCancelNote` | Product feedback | Admins | Note erased 90 days after deletion |
| Ratings: 1-5 stars and optional comment, each way | `Rating` | Quality and safety | Admins; averages shown to the other side (e.g. a driver sees a rider's average) | Stars kept; the rater's comments erased 90 days after the rater's account is deleted |
| Driver declining or letting a request time out | `RideRejection` | Dispatch and statistics (never a penalty) | Admins | With the ride |
| Driver's cash commission owed (15%) | `CommissionLedger` | Accounting | The driver, admins | Indefinitely (financial records) |
| Payment records | `Payment` | **Unused at launch** (cash only; `MOOLRE_PAYMENTS_ENABLED=false`) | n/a | n/a |

### Safety (SOS)

| Data | Where | Who receives it | Kept |
|---|---|---|---|
| SOS tracking link (random 32-character token) per rider per ride | `TrackingLink` | The rider's emergency contact and CampusRide support, by SMS | Link stops working 24 h after the trip ends (`TRACKING_LINK_TTL_HOURS`); row deleted at account deletion |
| SOS text: rider's name, pickup and drop-off zones, trip status, driver's name and plate, the link | Sent via **Moolre** SMS; not stored | Emergency contact; `SUPPORT_CONTACT_PHONE` | Not stored by us |
| Tracking page (`GET /track/:token`, public, no login): rider's name, a "Call" button with the rider's phone, the rider's pickup and drop-off place names, status, driver's name, car and plate. Never the driver's phone, the fare, coordinates, or other riders | Rendered from the database | Whoever has the link | As above |

### Sign-in and devices

| Data | Where | Why | Kept |
|---|---|---|---|
| Login codes: phone number + **SHA-256 hash** of the 6-digit code, purpose, attempts | `OtpCode` | Sign-up, sign-in, confirming account deletion | Valid 5 minutes. **Rows are not swept afterwards** (see "Gaps"); deleted at account deletion |
| Session (refresh) tokens, **hashed** | `RefreshToken` | Staying signed in | Expire after 30 days (admins: shorter); revoked at sign-out or deletion; rows deleted 90 days after deletion |
| **Push token** (Expo push token), which app, android/ios | `PushToken` | Ride notifications | Until sign-out, account deletion, or Expo reports the app uninstalled |
| Sign-in token on the phone | Phone's secure storage (`expo-secure-store`) | Staying signed in | Until sign-out or uninstall |

### Operations and diagnostics

| Data | Where | Kept |
|---|---|---|
| **Server request logs**: method, URL (scrubbed: no tokens, phone numbers masked), **IP address**, port, errors. Never headers or bodies (`lib/loggerOptions.ts`, `lib/redact.ts`) | Render's log store | Render's retention for the workspace's plan (a short period; check Render → Workspace → Logs) |
| **Crash and error reports** (Sentry): error message and stack trace, app version and build, OS and device model, over-the-air update id, a 2% sample of performance traces. Scrubbed of phone numbers, codes, tokens and request bodies before sending (`scrubSentryEvent` in `@rida/shared`); `sendDefaultPii: false`; **no screenshots or view hierarchy** | Sentry EU | Sentry's plan retention (30 days on the free plan when written; check the plan) |
| Rate-limit counters keyed by phone number, account id or IP | Server memory only | Minutes; lost on restart |
| Admin actions and **admin sign-in attempts, with IP and browser user agent** (admins only); "account closed" / "account erased" entries for every deletion | `AdminAuditLog` | Indefinitely (append-only) |
| App update checks: the phone asks Expo (`u.expo.dev`) for over-the-air updates on launch (IP address, platform, app/runtime version) | Expo | Expo's terms |
| Website demo login codes: phone number, code hash, **IP address** (only from the old v1 website's demo, `/demo/otp/*`) | `DemoOtp` | Deleted after 24 h |

## Who receives personal data

| Recipient | Role | What they receive | Location |
|---|---|---|---|
| **Other users** | Riders ↔ drivers on the same trip | Rider sees driver's name, phone (to call), photo, car, plate, live position during the trip. Driver sees each rider's name, phone, exact pickup/drop-off points and labels, pickup note, average rating. Riders sharing a car **don't** see each other's phone numbers or exact points | n/a |
| **Emergency contact** | Chosen by the rider | SOS text and tracking page (above) | n/a |
| **Moolre** | SMS provider (and payment provider, switched off) | Phone numbers and message text: login codes, SOS texts | Ghana |
| **Expo** (650 Industries, Inc.) | Push notification relay; app updates | Push token, notification title and text (may include a first name or pickup place); update requests | USA |
| **Google (Firebase Cloud Messaging)** | Delivers push notifications on Android | Push token and notification content | Global |
| **Apple (APNs)** | Delivers push notifications on iPhone | Same | Global |
| **Cloudinary** | Photo hosting | Driver photos | See account |
| **Sentry** (Functional Software, Inc.) | Error reporting | Scrubbed crash and error reports | EU, Frankfurt |
| **Render** | Hosting | Everything passing through the API; request logs with IP | EU, Frankfurt (API) |
| **Neon** | Database hosting | Everything in the database | EU, Frankfurt |
| **FOSSGIS e.V. (OSRM)** | Road routing | Rounded coordinates, from the server, no identity | Germany |
| **Google Maps / Apple Maps** | Map display on the phone | What the map SDK collects when loading maps | Global |
| **Authorities** | Only when required by law or for a safety emergency | What the request lawfully covers | Ghana |

**Not used:** advertising networks, analytics or tracking SDKs, data brokers.
Nothing is sold. No payment card or mobile money details are collected
(cash only at launch).

## Account deletion: what happens

From `apps/server/src/services/auth/deleteAccount.ts` (details:
[docs/account-deletion.md](../account-deletion.md)).

**At once:** name → "Deleted user", phone → `deleted:<id>`; can't sign in;
all sessions revoked; push tokens, SOS tracking links, pending login codes and
the emergency contact deleted; a driver goes offline and unapproved and their
plate and photo are removed from the profile; live connection closed.

**Kept 90 days, then erased** (`ACCOUNT_DELETION_RETENTION_DAYS`): name,
phone, and a driver's plate and photo URL, in `AccountDeletion`, which nothing
in the apps or admin site shows (safety reports, police requests). At 90 days
these are erased, together with the person's exact pickup/drop-off points,
pickup notes, cancel notes, rating comments they wrote, session token rows,
and a driver's photo on Cloudinary.

**Kept without a name:** trip records (times, zones, fares, stars), a
driver's commission records and car make/model/colour, the audit log entries,
and rating comments **other people** wrote about the person.

## Gaps found while building this

Not fixed on this branch (each would be its own change):

1. ~~**No age check.**~~ Done 2026-10-18: sign-up requires "I'm 18 or older
   and I agree to the Terms and Privacy Policy" (recorded with the terms
   version), and accounts from before are asked once. It's a self-declaration,
   not a verified age.
2. **Login code rows are never swept.** `OtpCode` keeps the phone number and
   code hash after the 5-minute validity, indefinitely, unless the account is
   deleted, including for people who never finished signing up. A daily job
   deleting codes older than a day would fix it; then shorten the privacy
   policy's "Sign-in codes" retention line to match.
3. **No tool for deleting an account on someone's behalf.** The website offers
   deletion by email (Google Play requires a route without the app), but there
   is no admin button or script that runs `deleteAccount` for another user, or
   texts them a confirmation code. Until one exists, emailed requests need a
   developer to run the deletion by hand.
4. **Expired session token rows** stay in `RefreshToken` until account
   deletion (hashed, harmless, but untidy).
5. **Sentry IP addresses:** the SDKs don't send IPs (`sendDefaultPii: false`),
   but Sentry can infer one from the connection. Turn on **Settings → Security
   & Privacy → Prevent Storing of IP Addresses** in the Sentry organization.
6. **Registration with Ghana's Data Protection Commission.** Act 843 requires
   data controllers to register. Not a code issue, but needed before launch.

## Store forms: suggested answers

Check each answer against the current form wording; Google and Apple change
them. "Shared" in Google's sense excludes service providers acting on our
behalf, legal requests, and transfers the user starts and that are disclosed.

### Google Play: Data safety

- **Does your app collect or share user data?** Yes.
- **Is all data encrypted in transit?** Yes (HTTPS / WSS only).
- **Do you provide a way to request deletion?** Yes. In-app (Account →
  Delete account) and the web link **https://campusride.app/delete-account**.

| Play category → type | Collected | Shared | Optional? | Purposes |
|---|---|---|---|---|
| Location → **Precise location** | Yes (both apps) | No¹ | Rider: required to book with pins; Driver: required to go online | App functionality |
| Location → Approximate location | Yes (derived zone) | No | as above | App functionality |
| Personal info → **Name** | Yes | No¹ | Required | App functionality, Account management |
| Personal info → **Phone number** | Yes | No¹ | Required | App functionality, Account management, Fraud prevention/security |
| Personal info → Other info (emergency contact) | Yes (rider) | No¹ | Optional | App functionality (safety) |
| Photos and videos → **Photos** | Yes (driver app) | No¹ | Required for drivers | App functionality, Account management |
| Financial info → Purchase history (fares of cash trips) | Yes | No | Required | App functionality |
| App activity → Other user-generated content (notes, rating comments) | Yes | No | Optional | App functionality |
| App activity → Other actions (trips, ratings) | Yes | No | Required | App functionality, Analytics² |
| App info and performance → **Crash logs**, **Diagnostics** | Yes | No (Sentry is a service provider) | Required | Analytics² |
| Device or other IDs (push token) | Yes | No | Optional (notifications) | App functionality |

¹ Shown to the other person on a trip, or texted to the emergency contact when
the rider presses SOS: core functionality the user starts, disclosed in the
app and policy. If you'd rather be conservative, mark Location, Name, Phone
number and Photos as **Shared** for "App functionality". Over-declaring is
safe; under-declaring is what gets apps removed.
² "Analytics" here means improving the service (crash fixing); there is no
analytics SDK.

Background location (driver app) also needs the separate **Location
permissions** declaration in Play Console:
[docs/runbooks/location-store-review.md](../runbooks/location-store-review.md).

### Apple: App Privacy

Data linked to the user: Contact info (Name, Phone number), Location (Precise,
Coarse), User content (Photos, Other user content), Purchases (Purchase
history), Identifiers (User ID: account id; Device ID: push token). Not
linked: Diagnostics (Crash data, Performance data). Tracking: **No**.
