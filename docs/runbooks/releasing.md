# Releasing the rider and driver apps

This guide is for anyone shipping a new version of the **CampusRide** (rider) or
**CampusRide Driver** app. It assumes no previous experience with Expo or EAS.

There are two ways to get a change onto people's phones:

|                   | Over-the-air update ("OTA")                   | New store build                                 |
| ----------------- | --------------------------------------------- | ----------------------------------------------- |
| What it ships     | Only the app's JavaScript, images and text    | A whole new app binary                          |
| How long it takes | Minutes                                       | Hours to days (build + App Store / Play review) |
| Who gets it       | Everyone with a matching build, automatically | Everyone, once they update from the store       |
| Tool              | `bash scripts/eas-update.sh`                  | `eas build` + `eas submit`                      |

Every command below is run from the repository root (`CampusRideApp/`) unless it
starts with `cd`. Each app is released on its own. If a change touches both apps,
release the rider app and then the driver app.

---

## 1. How an update reaches a phone

1. The app is opened from fully closed. Before it shows anything, it starts the
   version of the app it already has. It **never waits** for the network.
2. In the background, it asks EAS: "Is there a newer update for my build?"
3. If there is one, it downloads it quietly.
4. The new version is used **the next time the app is opened from fully closed**.

The app never restarts itself to apply an update, so nobody is interrupted in the
middle of a ride. A lint rule (`reloadAsync` is banned in `eslint.config.mjs`)
keeps it that way.

So after you publish, a phone usually needs **two launches** to show the change:
one to download the update, and one to start using it. "Fully closed" means swiped
away from the app switcher, not just sent to the background.

### Channels: which phones get which update

Every build belongs to one **channel**, set by the build profile in
`apps/<app>/eas.json`:

| Build profile | Channel       | Who has it                                                |
| ------------- | ------------- | --------------------------------------------------------- |
| `development` | `development` | Your own phone, for trying risky updates first (optional) |
| `preview`     | `preview`     | Testers. Installed from a link, not from a store          |
| `production`  | `production`  | The public, from the App Store / Play Store               |

An update published to `preview` reaches **only** preview builds. Real users only
ever get what you publish to `production`.

All three profiles talk to the production server (`https://api.campusride.app`).
That means a preview tester creates **real rides**.

### Fingerprints: which builds an update fits

Each build has a **fingerprint**: a code computed from its native parts (native
libraries, permissions, icons, `app.json`, `eas.json` and so on). An update is
labelled with the fingerprint of the code it was made from. EAS only delivers it
to builds with the **same** fingerprint. If you change something native and then
publish an update, the existing builds simply won't receive it, so they can't
crash on code they don't support. Users see nothing at all, so the mistake is
safe but easy to miss. Section 2 shows how to check beforehand.

Expo Go and `npm run dev:rider` / `dev:driver` never receive updates. They always
run the code on your Mac.

---

## 2. Can my change go over the air?

**Yes, OTA is fine** if you changed only:

- screens, layouts, colours, wording, fonts already in the app
- app logic in `apps/<app>/app`, `components`, `lib`, or in `packages/shared` /
  `packages/mobile-shared`
- images used inside screens (not the app icon or splash screen)
- bug fixes in any of the above

**No, you need a new store build** if you changed any of:

- `apps/<app>/app.json`: name, version, icon, splash, permissions, plugins,
  `extra`, anything
- `apps/<app>/eas.json`
- the `scripts` section of `apps/<app>/package.json`
- dependencies: adding, removing or upgrading any package that has native code
  (anything named `expo-…` or `react-native-…`, and the Expo SDK itself). When in
  doubt, assume a dependency change needs a build.
- the app icon or adaptive icon images

Changes to the **server** (`apps/server`) or the **admin** site never need either.
They deploy on their own (see `DEPLOY.md`). If an app change needs a new server
feature, deploy the server first.

**To be certain**, compare your code with the build that is on phones. Find the
build ID on [expo.dev](https://expo.dev) → the app → **Builds** → the latest
production build (the ID is in the page URL and on the page), then:

```bash
cd apps/rider    # or apps/driver
npx -y eas-cli@24 fingerprint:compare --build-id <BUILD_ID>
```

"Fingerprints are identical" means OTA is fine. Anything else means a new build.

---

## 3. Releasing an over-the-air update

Do this once per app. Example: the rider app.

### Step 1 — merge the change

Get the change reviewed and merged into `main` on GitHub as usual. Then:

```bash
git switch main
git pull
```

The release script refuses to publish uncommitted changes, and it refuses to
publish to production from anything but an up-to-date `main`.

### Step 2 — publish to preview

```bash
bash scripts/eas-update.sh rider preview "Fix pickup pin jumping on small phones"
```

The message is what you'll see later in the update list, so make it say what
changed. When it finishes, the output shows an **Update group ID** (and a link to
the update on expo.dev). Copy the group ID: you need it in step 4.

> The script sets the server address from `eas.json` itself, so whatever is in your
> local `apps/<app>/.env` file can't leak into a release.

### Step 3 — test it on a preview build

On a phone with the **preview** build installed:

1. Fully close the app, then open it. Wait about 10 seconds on Wi-Fi.
2. Fully close it again, then open it again.
3. Go to the **Account** tab and scroll to the bottom. The grey line should read
   `Version 1.0.0 · update xxxxxxxx · <today's date> · preview` (see section 6).
4. Test the change, plus a full ride from request to drop-off.

If something is wrong, stop here. Production users are not affected. Fix the
problem, merge the fix and start again from step 1.

### Step 4 — promote the exact same update to production

```bash
npx -y eas-cli@24 update:republish --group <GROUP_ID_FROM_STEP_2> --destination-channel production -m "Fix pickup pin jumping on small phones"
```

This copies the update you just tested to production, byte for byte, instead of
rebuilding it. Users get it the next time they open the app (two launches, as in
section 1).

> If you skipped preview and want to publish straight to production (not
> recommended), use `bash scripts/eas-update.sh rider production "<message>"`.

### Step 5 — check it

```bash
cd apps/rider
npx -y eas-cli@24 update:list --branch production
```

Your update should be at the top. Then repeat steps 2–5 with `driver` if the change
also touches the driver app.

---

## 4. Releasing a new store build

Use this when section 2 says you need a build. It takes longer and goes through
Apple and Google review.

### Step 1 — bump the version (when it's a real release)

In `apps/<app>/app.json`, raise `"version"` (for example `1.0.0` → `1.0.1` for
fixes, `1.1.0` for new features). Merge it to `main` like any change. You do **not**
need to touch build numbers. EAS counts those up by itself on every build.

### Step 2 — make a preview build and test it

```bash
cd apps/rider
npx -y eas-cli@24 build --profile preview --platform all
```

When it finishes (about 15–30 minutes), EAS shows a link and a QR code. Open it on
a test phone to install. iPhones must be registered first:
`npx -y eas-cli@24 device:create`. Test a full ride.

### Step 3 — make the production build and send it to the stores

```bash
npx -y eas-cli@24 build --profile production --platform all
npx -y eas-cli@24 submit --platform ios --latest
npx -y eas-cli@24 submit --platform android --latest
```

Then finish the release on App Store Connect and the Google Play Console (release
notes, then "Submit for review" or "Start rollout").

### What happens to people on the old build

They keep working. They keep getting OTA updates published for the **old**
fingerprint until they install the new version from the store. New OTA updates
published after the native change only reach the **new** build. If an OTA fix is
also needed on the old build, publish it from the old code (a git tag or commit
made before the native change).

### Forcing people off an old build ("Time to update")

Sometimes the old build must stop being used, for example because the server no
longer works with it. You can make the old version show a full-screen **"Time to
update"** screen that can't be closed. Its only button, **Update now**, opens the
app's store page.

**Only do this after the new version is live in BOTH stores** (Google Play and the
App Store) and you can install it from each store yourself. If you set it earlier,
people are told to update to a version they can't get yet, and they're locked out.

How to do it:

1. Find the new version number. It's `"version"` in `apps/<app>/app.json`, and the
   first number on the app's Account screen ("Version 1.1.0 (12) …").
2. Open the API service on Render → **Environment**.
3. Add the variable for that app and phone type, set to the new version (for
   example `1.1.0`). Anyone on a **lower** version sees the screen.

   | App    | iPhone                       | Android                          |
   | ------ | ---------------------------- | -------------------------------- |
   | Rider  | `MIN_VERSION_RIDER_IOS`      | `MIN_VERSION_RIDER_ANDROID`      |
   | Driver | `MIN_VERSION_DRIVER_IOS`     | `MIN_VERSION_DRIVER_ANDROID`     |

   Usually you set both phone types for the app, each only once that store has the
   new version.
4. **Save changes.** Render restarts the server (about a minute). Phones check
   when the app is opened and every time it's brought back on screen.

To undo it, delete the variable (or set it to a lower version) and save. The
screen goes away the next time the app is brought back on screen.

Good to know:

- **It compares the store version** (the number the store installed), not OTA
  updates. An OTA update can't get anyone past the screen; only the store can.
- **Nobody is blocked by mistake.** No variable set means nobody is blocked. If the
  check can't reach the server, or gets no answer within about 5 seconds, the
  app lets the person in. A value that isn't a version like `1.1.0` is ignored
  (the server's log says so when it starts).
- **Nobody is interrupted mid-trip.** A driver in a trip, or a rider searching,
  waiting for their driver or in the car, sees the screen only once the trip is
  over. A driver is switched offline when the screen comes up.
- **Store links.** On Android, Update now opens the app's Google Play page. On
  iPhone there's no link until you add one: until then the screen says
  "Search CampusRide in your app store". Once the App Store listing exists, add
  `STORE_URL_RIDER_IOS` and `STORE_URL_DRIVER_IOS` (the `https://apps.apple.com/…`
  page of each app). `STORE_URL_RIDER_ANDROID` and `STORE_URL_DRIVER_ANDROID`
  change the Play links, if ever needed. Links must start with `https://`.
- Anyone can see these values (`GET /app/min-version`); they're not secret.

---

## 5. Rolling back a bad update

If a production update causes problems:

### Step 1 — find the bad update's group ID

```bash
cd apps/rider    # or apps/driver
npx -y eas-cli@24 update:list --branch production
```

The newest group is at the top. Copy its group ID.

### Step 2 — roll it back

```bash
npx -y eas-cli@24 update:rollback <BAD_GROUP_ID> -m "Roll back: <what went wrong>"
```

This republishes the update that came **before** the bad one. If there was none,
it sends phones back to the version that shipped inside the store build. The bad
update must be the newest one on its channel for this to work. If you've published
again since, roll back the newest one first.

A rollback reaches phones the same way as any update: the next time the app opens,
then it applies on the launch after that. So act quickly, and also fix the server
if the problem is there.

**Last resort**, to send every production phone back to the code it shipped with:

```bash
npx -y eas-cli@24 update:roll-back-to-embedded --channel production -m "Back to store version"
```

Afterwards, fix the bug, merge it and release normally (section 3). The fix
replaces the rollback.

---

## 6. Which update is this phone running?

Open the app → **Account** tab → scroll to the bottom. The small grey line says:

- `Version 1.0.0 (12) · built-in · production` — the store build with
  build number 12, running the JavaScript it shipped with.
- `Version 1.0.0 (12) · update 3f9c2a1b · 14 Oct 2026 · production` — the
  same build, running the over-the-air update whose ID starts `3f9c2a1b`,
  published on 14 October (UTC). The EAS dashboard shows the same ID under
  Updates.
- `… · dev` — a development session (`expo start`), not a real build.

**Long-press the line** for **About this app**: the version, build number,
the **full** update ID, the channel and the runtime version. Ask testers to
send a screenshot of it with any bug report.

To match an update ID to a published update:

```bash
cd apps/rider    # or apps/driver
npx -y eas-cli@24 update:list --branch production       # find the group with that date
npx -y eas-cli@24 update:view <GROUP_ID>                # shows the iOS and Android update IDs
```

Each platform gets its own update ID inside a group. The same details are on
[expo.dev](https://expo.dev) → the app → **Updates**.

---

## 7. What a production build leaves out

Checked 2026-10-16 (`packages/shared/src/config/storeBuildConfig.test.ts`
fails if the build settings drift):

| Development-only thing | Why it isn't in a store build |
|---|---|
| Fake location (driver app, Account → Developer) | Behind React Native's `__DEV__`, which is `false` in a release build, so it is stripped out |
| Connection and server-address logs | Same: printed only under `__DEV__` |
| Raw error details on the driver photo card | Same |
| A laptop or Wi-Fi server address in `.env` | A release build refuses a local address and uses `https://api.campusride.app` (`@rida/shared` serverUrl, tested) |
| Mock driver, dummy SMS, load-test login code, USSD | Server-side: a production server refuses to start with any of them switched on |
| Prisma's query log | Development only (`PRISMA_QUERY_LOG`) |
| Dev client / debug menu libraries | Not installed (tested) |

---

## 8. Troubleshooting

**A phone doesn't get the update.**

1. Fully close and reopen the app **twice**, on a working connection.
2. Check the channel at the bottom of the Account tab matches where you published
   (`preview` vs `production`).
3. The update may not fit that build's fingerprint (section 2). Run
   `fingerprint:compare` against the build. If they differ, the change needs a new
   store build.

**The release script says "uncommitted changes".** Commit or stash your work first.
An update must always match a commit, so it can be found and rolled back.

**The release script says "production updates are published from main only".**
Use the preview → republish route in section 3, or switch to an up-to-date `main`.

**The release script says "google-services.json is missing".** Put the app's
Firebase file in place (see [push-notifications.md](push-notifications.md),
step 1). It's part of the fingerprint, so an update made without it would
reach no phone.

**`eas` asks you to log in.** Run `npx -y eas-cli@24 login` with the Expo account
that belongs to the `campusride-gh` organisation.
