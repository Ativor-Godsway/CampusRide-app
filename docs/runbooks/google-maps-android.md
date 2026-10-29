# Google Maps key for the Android apps

On Android, the rider and driver maps are drawn by **Google Maps**. Google Maps
needs an API key built into the app. Without one, the app **crashes the moment a
map opens**: for the driver that's right after sign-in (Home), and for the
rider it's Home and the ride screens. iOS uses Apple Maps and needs no key.
Expo Go has its own key built in, so the crash only shows in real builds
(preview APKs and store builds).

How the key gets into a build:

- The key lives in an **EAS environment variable**, `GOOGLE_MAPS_ANDROID_API_KEY`,
  in the `production` environment of each app's EAS project (all three build
  profiles use `production`). It is never committed: this repository is public.
- `apps/<app>/app.config.js` reads it into `android.config.googleMaps.apiKey`.
  Expo then writes it into the Android manifest as
  `com.google.android.geo.API_KEY`.
- If the variable is missing on an EAS build, the build **fails** with
  "GOOGLE_MAPS_ANDROID_API_KEY is not set". That's deliberate: a build that
  fails is better than a store build that crashes.

The key isn't a true secret. It ships inside every APK, and anyone can read it
from there. What protects it is the **restriction**: it only works for apps with
our package names that are signed with our keys, and only for Maps. That's why
step 2 matters.

The variable's visibility must be **Sensitive**, not Secret. The key is part of
the app's [fingerprint](releasing.md#fingerprints-which-builds-an-update-fits),
so `scripts/eas-update.sh` must be able to read it on your Mac when it publishes an
update. EAS gives your Mac Plain text and Sensitive variables, but never Secret
ones. With Secret, every update would carry a different fingerprint from the
builds and reach no phone.

---

## Step 1: collect the four SHA-1 fingerprints

A SHA-1 fingerprint identifies a signing key. Each app is signed by two keys, so
there are four in total:

| App    | Key                                         | Used for                                                                |
| ------ | ------------------------------------------- | ----------------------------------------------------------------------- |
| Rider  | Google Play **app signing** key             | Anything installed from Google Play (including internal/closed testing) |
| Rider  | EAS **upload** key (the keystore EAS keeps) | Preview APKs, and the uploads Play re-signs                             |
| Driver | Google Play app signing key                 | As above                                                                |
| Driver | EAS upload key                              | As above                                                                |

**Google Play app signing key** (once per app):

1. Open the [Play Console](https://play.google.com/console) and choose the app.
2. **Test and release** → **App integrity** (under Setup) → **App signing**.
3. Under **App signing key certificate**, copy the **SHA-1 certificate
   fingerprint** (looks like `AB:CD:12:…`, 20 pairs).

If the driver app hasn't been created in the Play Console yet, it has no Play
key yet. Start with its EAS key, then come back and add the Play one after its
first upload.

**EAS upload key** (once per app):

```bash
cd apps/rider     # then the same in apps/driver
npx -y eas-cli@24 credentials -p android
```

Choose the **production** build profile. The screen lists the keystore with its
**SHA1 Fingerprint**: copy it, then exit (don't change anything). The same
values are also on [expo.dev](https://expo.dev) → the app → **Credentials** →
Android → the package name.

---

## Step 2: create the restricted key in Google Cloud

Use the Google Cloud project your Firebase project lives in (every Firebase
project is a Google Cloud project), so everything stays in one place.

1. Open the [Google Cloud console](https://console.cloud.google.com) and choose
   that project at the top.
2. **Billing**: Google Maps only works on a project with a billing account
   linked. Check **Billing** in the menu and link one if asked. Native mobile
   maps (what our apps use) are listed by Google as free with no usage limit.
   Check the current [Maps pricing](https://mapsplatform.google.com/pricing/)
   page anyway.
3. **APIs & Services** → **Library** → search **Maps SDK for Android** →
   **Enable**.
4. **APIs & Services** → **Credentials** → **Create credentials** → **API key**.
   When it's created, choose **Edit API key**. Do not reuse the Firebase key
   that's already in the list.
5. **Name**: `CampusRide Android Maps`.
6. **Application restrictions** → **Android apps** → **Add** four times:

   | Package name            | SHA-1                           |
   | ----------------------- | ------------------------------- |
   | `com.campusride.rider`  | Rider's Play app signing SHA-1  |
   | `com.campusride.rider`  | Rider's EAS upload SHA-1        |
   | `com.campusride.driver` | Driver's Play app signing SHA-1 |
   | `com.campusride.driver` | Driver's EAS upload SHA-1       |

7. **API restrictions** → **Restrict key** → tick only **Maps SDK for Android**.
8. **Save**. Restrictions can take up to five minutes to apply.
9. Back in **Credentials**, click **Show key** next to it to copy it, ready for
   step 3. Don't paste it into a chat, a file in this repository or an issue.

---

## Step 3: give the key to EAS (both apps)

Run this once per app. With no `--value`, the command asks for the key and
hides what you type, so the key stays out of your shell history:

```bash
cd apps/rider
npx -y eas-cli@24 env:set --name GOOGLE_MAPS_ANDROID_API_KEY --environment production --visibility sensitive --type string

cd ../driver
npx -y eas-cli@24 env:set --name GOOGLE_MAPS_ANDROID_API_KEY --environment production --visibility sensitive --type string
```

Paste the same key both times. To check the variable is there (its value stays
hidden): `npx -y eas-cli@24 env:list --environment production`.

---

## Step 4: build, then test on an Android phone

The key is in the app config, so it changes the fingerprint: **existing builds
can't get it over the air**. Make new builds of both apps
([releasing.md](releasing.md)). Do this for iOS too, because the fingerprint
is shared.

1. Make a preview build of each app and install the APK on an Android phone.
2. Sign in. Home must show the map with roads and labels. A beige grid with no
   roads means the key was rejected: check the SHA-1s and package names in
   step 2, and wait the five minutes.
3. For the store: make a production build, submit it, and install it from a
   Play testing track. That copy is signed with the Play key, so this checks the
   other two SHA-1s.

---

## Changing or rotating the key

Create the new key (step 2), run step 3 again with the new value, and make new
builds of both apps. Delete the old key in Google Cloud only once everyone is on
the new builds, because old builds keep using the old key.
