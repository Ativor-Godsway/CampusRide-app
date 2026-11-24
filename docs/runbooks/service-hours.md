# Service hours

When riders can book. Admin site → **Settings → Service hours**. All times are
Ghana time (Africa/Accra = GMT, no daylight saving).

## What it does

- **Weekly schedule**: opening and closing time per day, or "Closed all day".
  Before anyone saves, the default applies: every day 08:00–17:00. A closing
  time at or before the opening time runs past midnight (20:00–02:00).
- **Open now / Close now**: lasts until the next scheduled change (Close now
  at 3 PM → closed until tomorrow's opening; Open now at 7 PM → open until the
  next scheduled closing), then the schedule takes over by itself. "Back to the
  schedule" ends it early.
- **Closed message** (optional): shown to riders whenever CampusRide is closed,
  followed by when it opens again. Clear it when it no longer applies.
- **Block requests when no drivers are online** (default on): during open
  hours, with no approved driver online, riders see "No drivers online right
  now – try again shortly".
- Every change is in the audit log (`service_hours.update`, `service_hours.override`).

## What it never does

- Cancel anything: requests already searching and trips going on carry on
  past closing time. Only new requests are refused.
- Block review demo accounts (store reviewers) or admins.
- Change launch mode: during a countdown riders still hear the launch time first.

## How riders see it

- New rider app (after the OTA): a banner on Home ("CampusRide is closed.
  We're back at 8:00 AM tomorrow."), Request disabled on Choose a ride, a soft
  "Closes at 5:00 PM" in the last 30 minutes, and "Notify me when you open".
  Updates live over the socket.
- Old rider builds: no banner; tapping Request shows "Couldn't request this
  ride" with the same sentence from the server (`POST /rides` → 422,
  `code` `SERVICE_CLOSED` or `NO_DRIVERS_ONLINE`, `error`, `nextOpenAt`).
  A 422 rather than a 409 on purpose: old builds read any 409 from
  `POST /rides` as "You already have a ride in progress".
- "Notify me": at the next opening each rider on the list gets one "We're
  open! Book your ride now." push, then the list is emptied. It appears in the
  Notifications history as "We're open (riders who asked)".
- Drivers (after the OTA): "Service hours 8:00 AM – 5:00 PM" on Home and, when
  riders can't book, "Riders can't book right now". Drivers can always go online.

Code: `packages/shared/src/service/serviceHours.ts` (rules and words),
`apps/server/src/services/service/` (isServiceOpen, the gate, the 15 s announcer).
