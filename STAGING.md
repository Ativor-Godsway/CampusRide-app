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

The drivers are approved, with a car, and owe nothing. To repair the accounts at any time (put the drivers back to approved, offline and owing nothing):

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

Always put `APP_VARIANT=staging` in front of the build command, exactly as below. EAS reads the app config twice: once on this Mac, to pick the bundle ID, signing credentials and build number, and again on the build server. The server knows it's a `preview` build, but the Mac doesn't: without `APP_VARIANT=staging` the Mac picks the production app (`com.campusride.rider`, "CampusRide") while the server builds the staging one, so the build uses the wrong credentials and adds 1 to the production build number. If the output says `Bundle identifier registered com.campusride.rider` or `com.campusride.driver` without `.staging`, press Ctrl+C.

```sh
cd apps/rider
```

```sh
APP_VARIANT=staging npx eas-cli@24 build --profile preview --platform ios
```

```sh
APP_VARIANT=staging npx eas-cli@24 build --profile preview --platform android
```

```sh
cd ../driver
```

```sh
APP_VARIANT=staging npx eas-cli@24 build --profile preview --platform ios
```

```sh
APP_VARIANT=staging npx eas-cli@24 build --profile preview --platform android
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

This runs the admin site on this Mac. Open http://localhost:5173 and sign in as Admin Staging with the staging code.

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
