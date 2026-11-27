# Staging: test every feature on your phone before it goes live

Staging is a full test copy of CampusRide:

- **Database:** the Neon branch `staging`. It started schema-only, holding no production rows. It then got production's setup data (zones, neighbours, places, far ends, prices, service hours, dispatch and wait-fee settings) and the test accounts below. It never holds a real rider, driver, phone, push token, ride or payment.
- **Server:** a free Render web service, `campusride-staging-api`, deployed from the git branch `staging`. It runs like production, with these differences:
  - no SMS: the test numbers sign in with a fixed code;
  - no Moolre;
  - Paystack test keys only.
  - It refuses to start against any production database.
- **Apps:** "CampusRide Staging" and "CampusRide Driver Staging". They install next to the store apps, with their own bundle IDs (`com.campusride.rider.staging`, `com.campusride.driver.staging`) and a STAGING band on the icon. They only ever talk to the staging server.
- **Updates:** published to the EAS branch `staging`, which the staging apps' channel (`preview`) points at. Production updates never reach them, and staging updates never reach the store apps.

Nothing here touches production. The scripts refuse the production database (`ep-empty-violet-bay5yr3y`) every time.

## Test accounts

| Who | Number | Type after +233 |
|---|---|---|
| Rider: Ama Staging | +233 99 000 0001 | 99 000 0001 |
| Rider: Kofi Staging | +233 99 000 0002 | 99 000 0002 |
| Rider: Esi Staging | +233 99 000 0003 | 99 000 0003 |
| Driver: Yaw Staging (Silver Toyota Vitz) | +233 99 000 0011 | 99 000 0011 |
| Driver: Abena Staging (Red Kia Picanto) | +233 99 000 0012 | 99 000 0012 |
| Admin: Admin Staging | +233 99 000 0021 | 99 000 0021 |

No Ghanaian network uses +233 99. The `+233099…` numbers the fake-request simulator uses can't be typed into the apps' phone field, because the field drops a leading 0.

**The login code** is the same for every test number: `STAGING_TEST_OTP` in `apps/server/.env.staging` on your Mac. It isn't written here because this repository is public. Show it with:

```sh
grep STAGING_TEST_OTP apps/server/.env.staging
```

The drivers are approved, with a car, and owe nothing. To repair the accounts at any time (put the drivers back to approved, offline and owing nothing, and clear the riders' scheduled-ride strikes):

```sh
npm run staging:accounts
```

## One-time setup

Do these in order. Every command runs from the repository folder unless a step says otherwise.

### 1. Put main on the staging branch

Render needs the git branch `staging` to exist before you create the service.

```sh
npm run staging:deploy -- main
```

### 2. Create the Render service

1. Open dashboard.render.com, click **New**, then **Web Service**.
2. Choose the repository **Ativor-Godsway/CampusRide-app**.
3. **Name:** `campusride-staging-api`. Use exactly this: the staging apps are built for `https://campusride-staging-api.onrender.com`. If Render says the name is taken, stop and ask, because the apps need the new address.
4. **Region:** Frankfurt.
5. **Branch:** `staging`.
6. **Root Directory:** leave empty.
7. **Runtime:** Node.
8. **Build Command:** `npm install && npm run build:server`
9. **Start Command:** `node apps/server/dist/apps/server/src/index.js`
10. **Instance Type:** Free.
11. Under **Advanced**, set **Health Check Path** to `/health` and leave **Auto-Deploy** on (On Commit).
12. Under **Environment Variables**, click **Add from .env** and paste the whole file `apps/server/.env.staging.render`. Open it with the command below. The lines starting with `#` are optional: fill one in only if you want it.
13. Click **Create Web Service**. When the log says the server is listening, run the wake command below to check it answers.

```sh
open -e apps/server/.env.staging.render
```

```sh
npm run staging:wake
```

The free plan **sleeps after about 15 minutes** without requests, and the first request then takes up to a minute. Run `npm run staging:wake` before testing. The fake-request simulator wakes the server by itself.

### 3. Point the staging apps' update channel at the staging branch

The staging apps are built with the `preview` profile, so they listen on the `preview` channel. Point that channel at the EAS branch `staging`, once per app.

A separate `staging` profile isn't possible: `eas.json` is part of every app's fingerprint, so changing it would force new store builds.

```sh
cd apps/rider
```

```sh
npx eas-cli@24 branch:create staging
```

```sh
npx eas-cli@24 channel:edit preview --branch staging
```

```sh
cd ../driver
```

```sh
npx eas-cli@24 branch:create staging
```

```sh
npx eas-cli@24 channel:edit preview --branch staging
```

```sh
cd ../..
```

### 4. Optional: Android push and maps for the staging apps

**Android push** needs a Firebase file that lists the staging packages. Without it, the Android staging apps work but get no push notifications. iOS push needs nothing extra.

1. In the Firebase console, open the CampusRide project and click **Add app**, then **Android**. Register `com.campusride.rider.staging` and download its `google-services.json`.
2. Do the same for `com.campusride.driver.staging`.
3. Save the files as `apps/rider/google-services.staging.json` and `apps/driver/google-services.staging.json` (gitignored). Upload each one to EAS from its app folder, starting with the rider:

```sh
cd apps/rider
```

```sh
npx eas-cli@24 env:create --name GOOGLE_SERVICES_JSON_STAGING --type file --value ./google-services.staging.json --environment production --visibility secret
```

```sh
cd ../driver
```

```sh
npx eas-cli@24 env:create --name GOOGLE_SERVICES_JSON_STAGING --type file --value ./google-services.staging.json --environment production --visibility secret
```

```sh
cd ../..
```

Keep the local file and the EAS variable the same file, or both absent. Otherwise staging updates won't match the staging builds.

**Android maps:** if the Google Maps Android key is restricted to app packages, add `com.campusride.rider.staging` and `com.campusride.driver.staging` to its allowed apps in the Google Cloud console. Use each package's signing SHA-1 from `npx eas-cli@24 credentials`. Without this, the map is blank on the Android staging apps.

### 5. Register your iPhone

Run this once and follow the link on your iPhone. Apple login is needed.

```sh
cd apps/rider
```

```sh
npx eas-cli@24 device:create
```

```sh
cd ../..
```

### 6. Build and install the two staging apps

For each app, build iOS and Android with the `preview` profile. On the first iOS build, EAS asks to create the new bundle ID, a provisioning profile that includes your iPhone, and a push key. Answer yes and log in to Apple.

```sh
cd apps/rider
```

```sh
npx eas-cli@24 build --profile preview --platform ios
```

```sh
npx eas-cli@24 build --profile preview --platform android
```

```sh
cd ../driver
```

```sh
npx eas-cli@24 build --profile preview --platform ios
```

```sh
npx eas-cli@24 build --profile preview --platform android
```

```sh
cd ../..
```

To install:
- **iPhone:** open each build's page in Safari on the phone, or scan the QR code EAS shows, and tap **Install**. The app appears as "CampusRide Staging" or "CampusRide Driver Staging", with the STAGING band.
- **Android:** open the build page on the phone and download the APK.

You need new staging builds only when a branch changes native code or app config, i.e. when its fingerprint changes. Everything else arrives as a staging update.

## Every feature

### 1. Put the branch on staging

This pushes the branch to `staging`, so Render redeploys, and applies the branch's migrations to the staging database.

```sh
npm run staging:deploy -- my-feature-branch
```

### 2. Wait for Render, then wake it

```sh
npm run staging:wake
```

### 3. Publish the staging updates from that branch

```sh
git checkout my-feature-branch
```

```sh
npm run staging:update -- rider "what changed"
```

```sh
npm run staging:update -- driver "what changed"
```

Then open each staging app, close it, and open it again: the update loads on the second launch.

### 4. Sign in and test

- Sign in with the test accounts above and the staging code.
- Rider and driver can be on the same iPhone: the staging rider app and the staging driver app.
- To fill the board and the pop-ups with fake riders, use the command below. `--open-now` opens CampusRide on staging outside service hours.

```sh
npm run staging:fake-requests -- --count 6 --minutes 2 --open-now
```

### 5. Clean up the fake riders

```sh
npm run staging:fake-requests:cleanup
```

### 6. Then the usual production steps

PR review, the production migration (if any), merge, production deploy, and the production OTA from main (`docs/runbooks/releasing.md`).

### The admin site against staging

This runs the admin site on this Mac. Open http://localhost:5173 and sign in as Admin Staging with the staging code. Type the number as `99 000 0021` or `+233 99 000 0021`: the site takes the short form only when the server says it is staging (its `/health` answers `staging: true`).

```sh
npm run staging:admin
```

## When staging gets into a muddle

**Wipe and rebuild** the staging database from scratch: all migrations of the current checkout, the saved setup snapshot (`apps/server/.staging/setup-snapshot.json`), and the test accounts.

```sh
npm run staging:db:rebuild --workspace apps/server -- --yes
```

**Refresh the setup data from production** (rare: after big place or price changes). This reads only the setup tables from a throwaway copy branch, never production itself, then deletes the copy.

```sh
npx neonctl branches create --project-id withered-voice-05688596 --name staging-seed-source-tmp --parent production
```

```sh
export SOURCE_DATABASE_URL="$(npx neonctl connection-string staging-seed-source-tmp --project-id withered-voice-05688596)"
```

```sh
npm run staging:seed --workspace apps/server -- --from-env SOURCE_DATABASE_URL
```

```sh
unset SOURCE_DATABASE_URL
```

```sh
npx neonctl branches delete staging-seed-source-tmp --project-id withered-voice-05688596
```

## First real use: the seats PR (`ride-seats`)

### Deploy it

This also adds the seats migration (`20261126120000_booking_seats`) to the staging database.

```sh
npm run staging:deploy -- ride-seats
```

```sh
npm run staging:wake
```

```sh
git checkout ride-seats
```

```sh
npm run staging:update -- rider "seats on bookings"
```

```sh
npm run staging:update -- driver "seats on bookings"
```

### What to check

1. **Rider (Ama):**
   - Choose a ride shows Shared at GH₵7.
   - "Bringing a friend?" + changes the price to GH₵14, then GH₵18.
   - + at 3 seats offers Ride alone for 4.
   - Request "Shared · GH₵14".
2. **Driver (Yaw):** the pop-up and board say "Shared · 2 seats". After accepting, the trip says "2 of 4 seats taken".
3. **Kofi:** books 3 seats. Yaw's board shows "Needs 3 seats, you have 2" and can't add him.
4. **Esi:** books 1 seat. Yaw can add her: "3 of 4 seats taken".
5. **Admin site:** Settings → Prices shows the table. Change a price there and check new quotes use it.

Then clean up the fake riders if you used them, and continue with the PR as usual.

## Scheduled rides (`scheduled-shared-rides`)

This branch is stacked on `ride-seats` (it needs seats on bookings). Deploying it to staging also adds its migrations: `20261127120000_scheduled_rides` and `20261128120000_scheduled_matching_limits`.

### Deploy it

```sh
npm run staging:deploy -- scheduled-shared-rides
```

```sh
npm run staging:wake
```

```sh
git checkout scheduled-shared-rides
```

```sh
npm run staging:update -- rider "scheduled rides"
```

```sh
npm run staging:update -- driver "scheduled rides"
```

Open each staging app, close it, and open it again. From this version on, a fresh launch shows "Updating…" for a few seconds when a newer staging update is waiting, and reloads into it (never during a ride).

### The three dispatch paths with fake riders

Sign in to the staging driver app as Yaw (`99 000 0011`) and go online. Then book fake scheduled riders. `--open-now` opens CampusRide on staging first, so this works at any time of day:

```sh
npm run staging:fake-schedule -- --open-now
```

It books three cars at three times later today, at least 40 minutes ahead and 30 minutes apart, all going to Balme Library. Run it early enough in the day. With `--open-now`, staging stays open until midnight.

1. **3 riders, 3 seats:** offered to drivers at once. Yaw gets a pop-up ("New scheduled trip", "Scheduled · 9:30 · 3 seats · GH₵21"). The car is also on the Requests board with a Scheduled label, and under "Open scheduled cars" in the Schedule tab.
2. **2 riders, 2 seats:** nothing yet. 30 minutes before its time, it is offered the same way.
3. **1 rider:** never offered. 20 minutes before its time, it becomes a normal live request: a pop-up and the board, as any request.

Then check:

- **Accept** car 1 in the pop-up. It moves to "My scheduled trips" with its riders and a **Leave by** time. Yaw gets a reminder notification 10 minutes before leave-by. At leave-by, the car becomes a normal trip and opens on its own.
- **Overlap:** try to accept car 2 with Yaw. If it is under 25 minutes from car 1, it says so. Car 2 is 30 minutes away by default, so it accepts.
- **Give back** car 1 (before leave-by). It is open again, and the riders hear "Finding you a new driver".
- **No driver:** leave car 2 alone. At 25 minutes before, its riders become live requests.
- **Admin site** (`npm run staging:admin`), **Scheduled**: the day's slots and cars, accepted, converted to live, no-shows and strikes. **Settings → Scheduled rides** has every number, and the intro switch.

To try the paths faster, lower the numbers in Settings → Scheduled rides on staging (for example "Offer later" 30 → 15 minutes). The server picks them up within a minute.

### The rider side with the test accounts

1. **Rider (Ama, `99 000 0001`):** on Home after a fresh launch, the "Book your ride ahead" intro shows. "Maybe later" closes it until the next launch. "Don't show again" closes it for good on this phone.
2. **Home → Schedule ahead** (the green card under "Where to?"). Step 1, "Scheduled ride · step 1 of 3": pick the pickup and drop-off. A small "Schedule for later" link under the Shared button on Choose a ride leads to the same time picker.
3. **Step 2, the time (today only):** a green banner ("Join cars going your way…"), "Join a car" chips, then **Arrive by** with the hours in 12-hour time ("9 AM", "1 PM") and wide tiles: the time big ("9:20") and under it "2 going your way" or "Join Yaw's car · 1 seat left". Tiles with riders are lightly green. Only times within today's service hours show (with 08:00–17:00, the last is 5:00 PM). Past times and times under 20 minutes away are hidden, unless there's a car with a driver to join. Then "Need a ride sooner? Book a normal ride instead." shows.
   - **Check the fixed bug:** pick a time, then tap another hour. The button goes back to "Choose a time" until you pick a tile in that hour. It never names a time from another hour.
   - **Check the tiles:** "9:20" never wraps.
4. **Step 3, confirm:** "Scheduled · arrive by 9:20 AM · Today", the pickup and drop-off, seats, the car you're joining (if any), the price and the free-cancel rule. Tap "Reserve seat · GH₵7".
5. Home now shows the card: seats filled ("2 of 4 seats filled"), "Waiting for riders". Once Yaw accepts, it shows "Car confirmed", Yaw, the car and the pickup window, plus "I'm coming". 10 minutes before the pickup window, Ama gets a reminder with an "I'm coming" button.
6. **Join a car that already has a driver:** once Yaw has accepted a car, sign in as Kofi (`99 000 0002`) and open the same time. The chip and the tile say "Join Yaw's car · 1 seat left". This stays open after the 20-minute cutoff, until the car's leave-by time.
7. **Matching by direction:** as Ama, book Pentagon → TF Hall for a time. As Kofi, book Pentagon → Alexander Kwapong Hall for the same time. They get different cars (the Schedule tab and the admin Scheduled page show two cars), and Kofi's tile doesn't count Ama as "going your way". Pentagon → a place next to TF does join Ama's car. The limits are in admin Settings → Scheduled rides: most extra route per added rider (1,000 m), while the car has few riders (1,500 m), and most extra driving (5 min).
8. **Cancel and strikes (Esi, `99 000 0003`):** cancel more than 30 minutes before the time: free. Book again and cancel within 30 minutes: a strike. A second strike blocks scheduling for 7 days, and the screen says until when. To clear Esi's strikes and block on staging, run `npm run staging:accounts`.

### The driver side (Yaw)

- The **Schedule tab** and the pop-up show each car as a card: the arrive-by time big, the total and "you get", **Leave by**, and a route summary ("2 pickups · 1 drop-off · 2.4 km").
- On your own cars, each rider is listed **in stop order**: name, seats, pickup place, and drop-off place. If they all go to the same place, it's one line, "All drop-offs: Balme Library". Each rider has a **Call** button, which opens the phone's dialler as on a trip. The staging test numbers aren't real phones, so the call itself won't connect.
- At leave-by, the trip opens with the riders in that same pickup order.

### Clean up

```sh
npm run staging:fake-schedule:cleanup
```

It removes the fake riders' scheduled bookings, and any car only they were in, then the fake riders and their rides. Real staging accounts and their bookings stay. The tool and the cleanup refuse any database but staging.

## Fill moving cars first + auto-add (`fill-moving-cars-first`)

A new Shared request goes first to the best car already on a trip going the same way. The limit is the scheduled-rides detour: 1 km / 5 min by default (admin Settings → Scheduled rides). With auto-add on, the rider joins at once and the driver can undo for 15 s. With it off, that driver alone gets the offer for 20 s. Only then does anyone else see the request.

### Deploy it

This also adds the migration `20261128180000_moving_cars_first` to the staging database.

```sh
npm run staging:deploy -- fill-moving-cars-first
```

```sh
npm run staging:wake
```

```sh
git checkout fill-moving-cars-first
```

```sh
npm run staging:update -- rider "fill moving cars first"
```

```sh
npm run staging:update -- driver "fill moving cars first"
```

Open each staging app, close it, and open it again. The driver app must have the update before it is auto-added to: an older app gets the 20 s offer instead.

### Set up: one moving car, one idle driver

1. Sign in two staging driver apps: **Yaw** (`99 000 0011`) and **Abena** (`99 000 0012`). Two phones, or one phone and a second device. Go online on both.
2. In Yaw's app, check **Account → Auto-add riders on my way** is on (the default).
3. **Ama** (`99 000 0001`) requests **Shared, Pentagon → Balme Library**. Yaw accepts. Yaw now has a moving car with a free seat. Abena stays free.

### Auto-add (on)

1. Send one fake rider on Ama's route:
   ```sh
   npm run staging:fake-requests -- --count 1 --minutes 0 --shared 1 --from pentagon --to balme --open-now
   ```
2. **Yaw:** a different sound (three rising notes) and a different buzz. A dark banner shows "Rider added · … · Pentagon … · +GH₵7 · +N min" with **Undo 15**. The stop list already has the new rider, in shortest-route order. With Yaw's app in the background, the same words come as a notification.
3. **Abena:** sees nothing: no pop-up, nothing on the board.
4. **Undo:** tap Undo within 15 s. The rider comes off Yaw's car without penalty, and Abena gets the request at once as a normal pop-up. Yaw is never offered it again. After 15 s, Undo is gone.

### Auto-add off: the exclusive 20 s offer

1. Yaw turns **Auto-add riders on my way** off.
2. Run the same fake-requests command again.
3. **Yaw:** the full-screen add, headed "On your way · add this rider", with "+GH₵7 · +N min · Pentagon … → Balme Library", one big **Add**, and a louder alert. It counts down 20 s.
4. **Abena:** nothing during those 20 s. If Yaw taps Skip, or lets it run out, Abena gets it at once.

### The rider who joins a moving car

1. With Yaw carrying Ama, and auto-add back on, **Kofi** (`99 000 0002`) requests **Shared, Pentagon → Balme Library**.
2. Kofi skips the search: "You've joined Yaw's car, already on the way. Pickup in about N min", with the car and plate, and the same as a notification.
3. Yaw taps **Undo**. Kofi's screen just goes back to searching, with no error and no "driver had to cancel".

### What doesn't pool

- Run fake-requests `--from pentagon --to jean-nelson` (the other way): it goes to normal dispatch, and Abena gets it.
- A Ride alone request is never auto-added.
- A request for more seats than Yaw has free is never auto-added.

### The board

1. In the admin site, turn **Settings → Ride requests → Fill moving cars first** off, so requests stay open.
2. Send one rider each way:
   ```sh
   npm run staging:fake-requests -- --count 2 --minutes 0 --shared 1 --from pentagon --to balme
   ```
   ```sh
   npm run staging:fake-requests -- --count 2 --minutes 0 --shared 1 --from bani --to jean-nelson
   ```
3. On Yaw's **Requests** tab, the Pentagon → Balme riders are at the top, marked "On your way · +N min".
4. Turn the switch back on.

### Admin

```sh
npm run staging:admin
```

**Settings → Ride requests** has:
- **Fill moving cars first**: the whole step on or off.
- **Auto-add riders, by default**: for drivers who haven't chosen.
- The last 7 days' counts: auto-added, offered, declined, didn't answer, undone, no moving car fitted.

Every request records its step in `Ride.movingStep`, for analysis.

### Clean up

```sh
npm run staging:fake-requests:cleanup
```
