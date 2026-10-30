# Driver location: Google Play and Apple review

How the driver app uses location in the background, what the stores need to
see, and the screen recording Google asks for. Written for the owner.
Added 2026-10-16.

## What the apps do

**Driver app**

- **Nothing is asked at install.** Location is asked for the first time a
  driver taps **Go online** on Home.
- **First a full-screen explanation** (Google's "prominent disclosure"):
  "Share your location while you're online. CampusRide Driver collects
  location data to share your position with riders and match you with
  nearby ride requests while you are online, even when the app is closed or
  not in use." Under it, four short lines, the last: "We keep your location
  history for up to 90 days for safety and service quality." Then
  **Continue** and **Not now**. Nothing is asked of the phone until the
  driver taps Continue.
- **Then the phone's own prompts:** "While using the app", then "Allow all
  the time" (Android opens the app's location settings page for this; iPhone
  shows "Change to Always Allow").
- **While online:** Android shows a notification the whole time, "You're
  online · CampusRide Driver is sharing your location." iPhone shows the blue
  location indicator.
- **Location stops** the moment the driver goes offline, signs out, deletes
  their account, finishes their last trip while offline, or swipes the app
  away. The notification goes with it.
- **"Not now", or "while using" only:** the driver can still go online;
  location is then shared only while the app is open, and the app says so
  once. A driver who refused location entirely is pointed to Settings.

**Rider app:** location only while the app is open, to show the nearest
pickup. It never asks for background location, declares no "Always"
permission or background mode, and doesn't include the background task
library. A test (`packages/shared/src/config/appLocationConfig.test.ts`)
fails if that ever changes.

**Declared by the driver app:** Android `ACCESS_FINE_LOCATION`,
`ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_LOCATION` (the service has `foregroundServiceType=location`);
iOS "When in use" and "Always" purpose strings and the `location`
background mode (only that one).

## Google Play Console (when you submit the driver app)

1. **App content → Sensitive permissions → Location permissions:**
   - Background location is used for: **"Sharing the driver's live position
     with the rider on their trip, and matching the driver with nearby ride
     requests, while the driver has chosen to be online."**
   - Why it needs to work in the background: **"Drivers switch to navigation
     apps or lock the phone while driving; riders must still see the car
     approach, and requests must still match the driver's current area."**
   - **Video:** a link to the recording below (YouTube "Unlisted" is fine).
2. **App content → Foreground service permissions:** type **Location**;
   use case **"Sharing a driver's location with riders while the driver is
   online, started by the driver going online and stopped when they go
   offline"**; the same video.
3. **Data safety:** Location → **Precise location**, collected, **shared**
   (with riders on the trip), not optional for drivers who go online.
   Purposes: **App functionality**, **Fraud prevention, security, and
   compliance** (safety: looking into reports about trips) and **Analytics**
   (service quality: where and when drivers are available). Processed
   ephemerally: **No** — a location history is kept, collected only while
   online, and deleted after 90 days (the privacy policy says so).

The rider app needs none of this: it has no background location.

## Apple (App Store Connect → App Review Information → Notes)

> CampusRide Driver uses background location only while a driver has
> switched Online on the Home screen. It shares the driver's live position
> with the rider on their trip and matches the driver with nearby ride
> requests while they use navigation apps or lock the phone. Location stops
> when the driver goes Offline. A location history (one point about every
> 30 seconds while online) is kept for up to 90 days for safety and service
> quality, then deleted. A full explanation is shown before the location
> prompt. Test account: [driver test number and code process].

## The 30-second screen recording

Record on an **Android** phone (Google's review is the one that asks), with
a **fresh install** of a build from this change, signed in as an approved
driver, standing inside the campus area, with **notifications allowed**.
Use the phone's own screen recorder (quick settings → Screen record, with
"Show touches" on). Before recording: Settings → Apps → CampusRide Driver →
Permissions → Location: **"Don't allow"**, so the prompts appear.

| Time | Do this | The video shows |
|---|---|---|
| 0:00–0:03 | Open CampusRide Driver; you're on Home, **Offline**. | The app in normal use, offline. |
| 0:03–0:05 | Tap the **Online** switch. | The full-screen explanation appears. |
| 0:05–0:10 | Pause for 3 seconds so it can be read, then tap **Continue**. | The disclosure text, including "even when the app is closed or not in use", then Continue. |
| 0:10–0:13 | The phone asks for location: tap **While using the app**. | The system prompt, *after* the disclosure. |
| 0:13–0:18 | The location settings page opens: choose **Allow all the time**, then go back. | Background permission granted by the driver. |
| 0:18–0:21 | Home now shows **Online**. | Going online. |
| 0:21–0:25 | Swipe down from the top of the screen. | The notification "You're online · CampusRide Driver is sharing your location." |
| 0:25–0:28 | Press Home, open Google Maps (or any app) for 2 seconds. | The notification and the location icon in the status bar while CampusRide is in the background: location in use. |
| 0:28–0:30 | Back in CampusRide, tap **Go offline**, swipe down. | The notification is gone: location stopped. |

If the last step doesn't fit in 30 seconds, end on step 0:25–0:28; Google
mainly needs the disclosure, the prompt, and location in use.
