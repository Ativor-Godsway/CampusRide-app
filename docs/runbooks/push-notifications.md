# Push notifications

The rider and driver apps get push notifications through the **Expo push
service**, which hands them to Google (Android) and Apple (iOS). This guide
covers the one-time setup and how to test every notification on real Android
phones.

How it works, briefly:

- After login, each app shows a short screen explaining notifications, and only
  then asks for permission. It never asks on first launch, and never mid-ride.
- If the person allows them, the app sends the server its **push token**. That
  is an address for this app on this phone, stored in the `PushToken` table.
- When something happens to a ride, the server sends a notification to that
  person's tokens (`apps/server/src/services/push`).
- Logging out deletes that phone's token. Deleting the account deletes all of
  them. Tokens that Expo reports as dead (app uninstalled) are deleted
  automatically.

---

## What each notification says

Only first names are ever used. Notification text shows on a locked screen.

| Who gets it | When                                                                             | Text (example)                                                                             | Tap opens                     |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| Rider       | A driver accepts                                                                 | **Driver on the way** · Kofi is coming to pick you up.                                     | The ride screen               |
| Rider       | The driver comes within ~350 m of the pickup (at least a minute after accepting) | **Driver almost there** · Kofi is almost at your pickup.                                   | The ride screen               |
| Rider       | The driver taps "I'm here" (or arrives automatically)                            | **Your driver is here** · Kofi is at your pickup.                                          | The ride screen               |
| Rider       | The driver picks them up                                                         | **Trip started** · You're on your way. Enjoy the ride.                                     | The ride screen               |
| Rider       | The driver drops them off                                                        | **Trip complete** · Thanks for riding with CampusRide.                                     | Rides tab                     |
| Rider       | The driver cancels their pickup, or marks them as not there                      | **Pickup cancelled** · Kofi cancelled your pickup… / Kofi couldn't find you at the pickup… | Home                          |
| Rider       | 90 seconds of searching finds no driver                                          | **No driver yet** · Open CampusRide to keep waiting or change your ride.                   | The ride screen (to choose)   |
| Driver      | A new request is offered to them (online and not on a trip)                      | **New ride request** · Pickup at Balme Library. Open the app to accept.                    | Home, where the offer pops up |
| Driver      | The rider cancels a ride the driver accepted                                     | **Ride cancelled** · Ama cancelled the ride.                                               | The trip screen               |

**While the app is open**, a notification shows as a banner unless the screen
you're on already shows the same news live:

- Rider app: no banner on the ride screen. A banner on Home, Rides and Account.
- Driver app: no banner for a new request on Home, because the offer pop-up is
  there with its own sound. No banner for a cancellation on the trip screen.

**Android channels**: the rider app's notifications are in the channel **Ride
updates** and the driver app's in **Ride requests**. Both are high importance
with sound, so they pop up on screen. You can see them in Android Settings →
Apps → CampusRide (Driver) → Notifications.

**Limits**: one person gets at most 6 notifications a minute, and the same
notification about the same ride is never sent twice in a row. A driver gets a
given request only once in 10 minutes, even if it is offered again. If the push
service fails, the ride carries on as normal and the server log shows
`push: … failed`.

---

## One-time setup

### Step 1: put the two Firebase files in place (on your Mac)

You have `google-services-rider.json` and `google-services-driver.json`.
Rename and move them like this:

| Your file                     | Goes to (exact name)               |
| ----------------------------- | ---------------------------------- |
| `google-services-rider.json`  | `apps/rider/google-services.json`  |
| `google-services-driver.json` | `apps/driver/google-services.json` |

**Do not commit them.** The GitHub repository is public, and these files contain
a Firebase API key. Git already ignores them (`.gitignore`: `google-services*.json`).
Check with `git status`: they must not appear. Keep a copy in your password
manager, too.

Your Mac needs these copies because:

- `expo start` and `expo prebuild` read them; and
- the over-the-air release script (`scripts/eas-update.sh`) refuses to run
  without them. The file's contents are part of the app's
  [fingerprint](releasing.md#fingerprints-which-builds-an-update-fits), so the
  copy here must be **exactly the same file** you upload in step 2.

### Step 2: give EAS the same files, as secret file variables

EAS Build only uploads files tracked by git, so it gets each file from a
secret file variable instead. `apps/<app>/app.config.js` points the app at
`GOOGLE_SERVICES_JSON` when it is set (on an EAS build worker) and at
`./google-services.json` otherwise (on your Mac). The fingerprint hashes the
file's contents, not where it is, so both give the same fingerprint as long as
the two are the same file. All three build profiles use the `production`
environment, so the production variable is the one builds read.

`eas config` on your Mac still shows `./google-services.json`. That's expected:
a secret variable is only ever available on EAS's build workers.

```bash
cd apps/rider
npx -y eas-cli@24 env:set --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --environment production --visibility secret

cd ../driver
npx -y eas-cli@24 env:set --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --environment production --visibility secret
```

`env:set` creates the variable or replaces it, so if you ever replace a file,
put the new file on your Mac and run the same command again. Both copies must
always match. To check the variable is there (its value stays hidden):
`npx -y eas-cli@24 env:list --environment production`.

### Step 3: let Expo send through Firebase (FCM V1 key)

Expo needs a Google **service account key** to deliver Android notifications.
This key **is** a real secret: never put it in the repository or in chat.

1. Open the [Firebase console](https://console.firebase.google.com), then the
   project your two apps are in → ⚙️ **Project settings** → **Service accounts**.
2. Click **Generate new private key** and save the JSON file somewhere outside
   the repository (for example `~/Documents/keys/`).
3. Upload it for each app:
   ```bash
   cd apps/rider
   npx -y eas-cli@24 credentials -p android
   ```
   Pick any build profile (they share Android credentials), then follow the
   menu: **Google Service Account** → the **FCM V1** push notifications key →
   set it up by **uploading** a key, and choose the JSON file.
   Then do the same in `apps/driver`. The same key works for both apps if
   they're in the same Firebase project.
4. Delete the downloaded JSON from your Mac afterwards, or keep it only in your
   password manager.

### Step 4: create the database table

Before merging the PR, apply the migration
`apps/server/prisma/migrations/20261015120000_push_tokens` to production, the
same way you apply other migrations. It only **adds** a new table (`PushToken`)
and changes nothing that exists. It is safe to apply before the new server code
is deployed.

### Step 5: server settings

Nothing to set. Two optional variables exist (see `DEPLOY.md`):
`PUSH_DISABLED=true` switches sending off, and `EXPO_ACCESS_TOKEN` is only
needed if you turn on "Enhanced Security for Push Notifications" in your Expo
account settings.

### Step 6: build the Android preview apps

After the PR is merged and the server has redeployed:

```bash
git switch main && git pull
cd apps/rider  && npx -y eas-cli@24 build --profile preview --platform android
cd ../driver   && npx -y eas-cli@24 build --profile preview --platform android
```

Each build ends with a link and a QR code. Open them on the test phone(s) to
install. If a build fails with "google-services.json is missing", step 2 wasn't
done for that app.

Push notifications **do not work in Expo Go**, on an emulator without Google
Play, or on a simulator. The apps simply don't offer them there.

(iOS needs an Apple Developer account. On the first iOS build, EAS asks whether
to set up push notifications for you. Answer yes. Step by step:
[ios-first-build.md](ios-first-build.md#3-first-build-which-also-sets-up-signing-and-push-on-your-mac).)

---

## Testing every notification on Android

### What you need

- Phone **R** with the rider preview app, signed in as a rider.
- Phone **D** with the driver preview app, signed in as an **approved** driver.
- You can use one phone with both apps installed instead, signed in as
  different accounts. The "open / background / closed" states then mean the
  state of the app that receives the notification.

The preview apps talk to the **production** server, so these are real rides.
Cancel or finish every test ride.

### The three states

Test each notification in all three:

| State            | How to get there                                                 |
| ---------------- | ---------------------------------------------------------------- |
| **Open**         | The app is on screen.                                            |
| **Background**   | Press the Home button. The app is still in the recent-apps list. |
| **Fully closed** | Open recent apps and **swipe the app away**.                     |

⚠️ Do **not** use Android Settings → **Force stop**. A force-stopped app gets no
notifications at all until it's opened again; that's Android's rule, not a bug.
On Tecno, Infinix, itel, Xiaomi and similar phones, also allow the app to run
in the background: Settings → Apps → CampusRide → Battery → **No restrictions**,
and turn on **Auto-start** if offered. Otherwise the phone may block
notifications to closed apps.

### First: the permission flow

1. Install the app fresh and open it. **Expected:** no permission prompt. You
   see the sign-in screen.
2. Sign in. **Expected:** the "Turn on notifications" screen with the reasons.
   (For the driver: after approval, on the Home tab.)
3. Tap **Turn on notifications**. **Expected:** Android's prompt. Allow it.
4. In Android Settings → Apps → the app → Notifications, check that the channel
   **Ride updates** (rider) or **Ride requests** (driver) is there.
5. Also try **Not now** on another install. **Expected:** the screen never
   opens by itself again. Account → **Notifications** opens it any time.

### Then: each notification

For each one, do it three times: with the receiving app open, in the
background, and fully closed. **Expected when open** is the banner rule above.
**Expected in the background or closed:** the notification appears with sound,
and tapping it opens the screen in the table at the top.

1. **New ride request** (to D)
   1. On D, go online and stay near campus with the app open for a few seconds
      (so your zone is current). Then set D's app to the state you're testing.
   2. On R, request a ride from somewhere near D.
   3. **Open:** on D's Home, the offer pops up and there is no banner. On D's
      Account tab, a banner appears.
   4. **Background / closed:** "New ride request · Pickup at …". Tap it: Home
      opens and the offer pops up (if it's still within its 15 seconds; if not,
      the request is in the list).
2. **Driver on the way** (to R): with R in the state under test, D accepts R's
   request.
3. **Driver almost there** (to R): request a ride with the pickup **600 m – 1 km**
   from D. D accepts, waits at least a minute, then moves towards the pickup
   with the trip screen open. When D is about 350 m away, R gets the
   notification once. (This needs real movement: the fake location is only in
   development builds.)
4. **Your driver is here** (to R): D taps "I'm here" at the pickup.
5. **Trip started** (to R): D picks R up.
6. **Trip complete** (to R): D drops R off. Tap opens **Rides**.
7. **Pickup cancelled** (to R): D accepts, then cancels R's pickup before
   tapping "I'm here". For the no-show version, D taps "I'm here", waits 3
   minutes, and marks R as not there.
8. **No driver yet** (to R): with no driver online nearby (D offline), R
   requests a ride and waits 90 seconds. Tap opens the ride screen with the
   keep-waiting / change choices.
9. **Ride cancelled** (to D): D accepts R's request, then R cancels. With D on
   the trip screen there's no banner, because the screen updates by itself. On
   another tab, or in the background or closed, D gets "Ama cancelled the ride",
   and tapping it opens the trip.

### Last: logging out stops them

1. On R, request a ride.
2. Still on R, log out (Account → Log out). Logging out doesn't cancel the ride.
3. On D, accept it. **Expected:** phone R gets nothing.
4. Sign R back in and cancel the ride.

### If something doesn't arrive

1. Check the app has permission: Account → **Notifications** should say
   "Notifications are on".
2. Check the phone's battery settings (see the warning above), and that it is
   online.
3. Look at the server log on Render (Logs tab) at the time:
   - `push sent` with `devices: 1` means the server sent it. The problem is
     between Expo/Google and the phone; check battery settings and the FCM V1
     key (step 3).
   - Nothing at all means no token is stored for that person. Open the app
     while signed in; it registers on every launch.
   - `push: not accepted` / `not delivered` with an error such as
     `InvalidCredentials` means the FCM V1 key is missing or wrong (step 3).
