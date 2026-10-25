# iOS: the first App Store builds

The first iPhone builds of the rider app (**CampusRide**, `com.campusride.rider`)
and the driver app (**CampusRide Driver**, `com.campusride.driver`), on a
personal (**Individual**) Apple Developer account. Written 2026-10-23.

Everything the code can do is done and pinned by tests
(`packages/shared/src/config/iosStoreConfig.test.ts`,
`storeBuildConfig.test.ts`, `appLocationConfig.test.ts`). This page covers what
is set up, what only you can do in Apple's and Expo's websites, and the reasons
Apple most often rejects ride apps, with how CampusRide is covered.

## What is already set up

|                   | Rider                                                                                                               | Driver                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Bundle ID         | `com.campusride.rider`                                                                                              | `com.campusride.driver`                                |
| Version           | 1.0.0                                                                                                               | 1.0.0                                                  |
| Build number      | EAS counts it up on every production build (`appVersionSource: remote`, `autoIncrement`)                            | same                                                   |
| Export compliance | `ITSAppUsesNonExemptEncryption = false`: App Store Connect won't ask the encryption question (HTTPS only is exempt) | same                                                   |
| iPad              | Not supported (`supportsTablet: false`): no iPad screenshots needed                                                 | same                                                   |
| Background modes  | None                                                                                                                | `location` only (no `fetch`, no `remote-notification`) |
| Push              | Visible alerts through Expo's push service; EAS stores the Apple push key                                           | same                                                   |
| Privacy manifest  | Yes (below)                                                                                                         | Yes (below)                                            |

**Why no `remote-notification` background mode:** every CampusRide push is a
visible alert (title, text, sound). That mode is only for silent background
pushes, which the server never sends, and Apple asks about background modes
an app doesn't use.

**Icons and splash are temporary.** The driver app has its own temporary icon
(dark background), so the two apps look different on a phone. The designer's
final art is a file swap followed by a new build. The exact files, and when
to keep 1.0.0 or bump to 1.0.1, are in
[releasing.md](releasing.md#swapping-in-the-final-icons-and-splash).

### Privacy manifest (PrivacyInfo.xcprivacy)

Written into each build from `ios.privacyManifests` in `apps/<app>/app.json`.

**Tracking:** none (no ads, no analytics, no tracking domains).

**"Required reason" APIs** (the same in both apps), the union of what React
Native, the Expo modules, react-native-maps and Sentry declare:

| API              | Reasons                | Comes from                                                                                                         |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| UserDefaults     | CA92.1                 | React Native, expo-constants, expo-notifications, expo-system-ui, expo-updates, expo-task-manager (driver), Sentry |
| File timestamps  | C617.1, 0A2A.1, 3B52.1 | React Native, expo-application, expo-file-system, react-native-maps, Sentry                                        |
| System boot time | 35F9.1                 | React Native, expo-device, Sentry                                                                                  |
| Disk space       | E174.1, 85F4.1         | expo-file-system                                                                                                   |

The test fails if a library added later declares a reason the app's
manifest doesn't.

**Data collected**, all for **App functionality**, none used for tracking
(from [data-inventory.md](../store/data-inventory.md)):

| Data                                                                              | Rider                        | Driver            | Linked to the person? |
| --------------------------------------------------------------------------------- | ---------------------------- | ----------------- | --------------------- |
| Name                                                                              | ✓                            | ✓                 | Yes                   |
| Phone number                                                                      | ✓                            | ✓                 | Yes                   |
| Precise location                                                                  | ✓ (pickup and drop-off pins) | ✓ (while online)  | Yes                   |
| Coarse location (campus zone)                                                     | ✓                            | ✓                 | Yes                   |
| Photos                                                                            |                              | ✓ (profile photo) | Yes                   |
| Other user content (pickup notes, rating comments, the rider's emergency contact) | ✓                            | ✓                 | Yes                   |
| Purchase history (fares)                                                          | ✓                            |                   | Yes                   |
| Other financial info (earnings, commission owed)                                  |                              | ✓                 | Yes                   |
| Other data (car make, model, colour, plate)                                       |                              | ✓                 | Yes                   |
| User ID (account id)                                                              | ✓                            | ✓                 | Yes                   |
| Device ID (push token)                                                            | ✓                            | ✓                 | Yes                   |
| Crash data, performance data (Sentry, scrubbed)                                   | ✓                            | ✓                 | No                    |

Your **App Privacy** answers in App Store Connect (step 6) must say the same.

### Permission texts (what the iPhone shows)

| Permission            | App    | Text                                                                                                                                                                                                                                       |
| --------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Location, while using | Rider  | CampusRide uses your location while you're using the app to show where you are on the campus map and to suggest the pickup point nearest you. It isn't used in the background.                                                             |
| Location, while using | Driver | CampusRide Driver uses your location while you are online to match you with nearby ride requests and to show riders on your trip where you are.                                                                                            |
| Location, always      | Driver | CampusRide Driver uses your location while you are online, even when the app is closed or not in use, to share your position with riders on your trip and match you with nearby ride requests. Location sharing stops when you go offline. |
| Camera                | Driver | CampusRide Driver uses your camera so you can take your profile photo. Riders see it to recognise you at pickup, and CampusRide checks it before approving you as a driver.                                                                |
| Photos                | Driver | CampusRide Driver uses your photo library so you can choose your profile photo. Riders see it to recognise you at pickup, and CampusRide checks it before approving you as a driver.                                                       |

Three more texts are in the build only because a library _could_ use the
feature; CampusRide never asks for them, so nobody sees them. They used to be
the libraries' generic "Allow CampusRide to …" placeholders, which reviewers
flag. They now say plainly that the feature isn't used: **Face ID** (from the
secure sign-in storage), **Motion & Fitness** (from the location library) and,
in the driver app, **Microphone** (from the photo picker; photos only, never
video). The keys stay because Apple refuses an upload whose code links one of
these features without a text.

The rider app never asks for "Always"; the driver app asks only when the
driver first goes online, after the full-screen explanation, and stops
location when they go offline, sign out, or swipe the app away (see
[location-store-review.md](location-store-review.md)).

---

## What you do by hand

**Don't** start before Apple emails that your membership is active. Each step
says where. Do the rider app first, then repeat for the driver app where it
says so.

### 1. Check the account (developer.apple.com → Account)

1. **Membership details** says _Individual_ and _Active_. Your **legal name**
   is the seller name shown under both apps on the App Store; that can't be
   changed without moving to an Organization account.
2. **App Store Connect → Business:** accept the **Apple Developer Program
   License Agreement** if a banner asks. Free apps need no tax or bank details.
3. Make sure you can approve two-factor codes on a device (phone, iPad or Mac
   signed in with this Apple ID): EAS signs in with your Apple ID once.

### 2. Create the two apps in App Store Connect

App Store Connect → **Apps → + → New App**, once per app:

| Field            | Rider                  | Driver                  |
| ---------------- | ---------------------- | ----------------------- |
| Platform         | iOS                    | iOS                     |
| Name             | CampusRide             | CampusRide Driver       |
| Primary language | English (U.K.)         | English (U.K.)          |
| Bundle ID        | `com.campusride.rider` | `com.campusride.driver` |
| SKU              | `campusride-rider`     | `campusride-driver`     |
| User access      | Full access            | Full access             |

App names are unique across the whole App Store. If "CampusRide" is taken,
use e.g. "CampusRide Legon" here; the name under the icon on the phone stays
"CampusRide" (that comes from `app.json`).

If the bundle ID isn't in the list yet: skip this step, do step 3 first (EAS
registers both bundle IDs with Apple), then come back.

### 3. First build, which also sets up signing and push (on your Mac)

```bash
git switch main && git pull
cd apps/rider
npx -y eas-cli@24 build --platform ios --profile production
```

EAS asks a few questions the first time. Answer:

| EAS asks                                                     | Answer                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Log in to your Apple account?                                | **Yes**, your Apple ID and password, then the 2-factor code                                                                  |
| Select a team                                                | Your personal team (your name, _Individual_)                                                                                 |
| Generate a new Apple Distribution Certificate?               | **Yes**                                                                                                                      |
| Generate a new Apple Provisioning Profile?                   | **Yes**                                                                                                                      |
| Set up Push Notifications for your project?                  | **Yes**                                                                                                                      |
| Generate a new Apple Push Notifications service key?         | **Yes** (rider app). For the driver app: **reuse the key** created for the rider app (one key serves every app on your team) |
| No remote version for iOS yet; set the initial build number? | Accept the suggestion (1). EAS counts up from there by itself                                                                |

EAS keeps the certificate, profile and push key on its servers. You never
handle them; don't save them in the repository. Nothing in the server needs
changing for iPhone push: the Expo push service uses the key EAS holds.

Then the same for the driver app:

```bash
cd ../driver
npx -y eas-cli@24 build --platform ios --profile production
```

**Check the push key is attached**, for each app:

```bash
npx -y eas-cli@24 credentials --platform ios
```

Choose `production`, and look for **Push Notifications Key** with a key ID.
(Or on expo.dev → the project → Credentials → iOS → `com.campusride.rider`.)

### 4. Send the builds to TestFlight

```bash
cd apps/rider && npx -y eas-cli@24 submit --platform ios --latest
cd ../driver  && npx -y eas-cli@24 submit --platform ios --latest
```

The first time, let EAS **create an App Store Connect API key** (yes). After
Apple processes the build (10–30 minutes) it appears in App Store Connect →
the app → **TestFlight**.

### 5. Test on a real iPhone (TestFlight)

1. App Store Connect → TestFlight → **Internal testing → +**, add yourself
   (and anyone with an iPhone who helps you) as a tester.
2. Install **TestFlight** from the App Store on the iPhone, accept the
   invitation, install CampusRide and CampusRide Driver.
3. Check, at least:
   - **Push:** sign in, allow notifications after the explanation screen, then
     run a ride with the other app; follow the list in
     [push-notifications.md](push-notifications.md#testing-every-notification-on-android)
     (the same notifications; on iPhone "fully closed" is swiping the app up
     out of the app switcher).
   - **Driver location:** go online, see the explanation, allow "While using",
     then choose **Change to Always Allow** when iOS asks. Lock the phone:
     the rider still sees the car move. Go offline: the location arrow in the
     status bar goes away.
   - **Review demo** (step 7) in both apps.
   - **Delete account** opens and explains (no need to finish it).

Push needs a real iPhone; simulators and Expo Go don't get pushes.

### 6. Fill in the App Store listing (App Store Connect → each app)

- **App Privacy → Get started:** Privacy Policy URL
  `https://campusride.app/privacy`. Answer "Yes, we collect data", then tick
  exactly the types in the table above for that app, each as **App
  functionality**, **linked to the user** (crash and performance data: _not
  linked_), **not used for tracking**.
- **App Information:** category **Travel**; Content Rights: _doesn't contain
  third-party content_; **Age Rating:** answer the questionnaire honestly
  (no violence, gambling, etc.). The terms require riders and drivers to be
  18+, so if the calculated rating is lower, use the option to choose a
  higher rating and pick **18+**.
- **Pricing and Availability:** Free; availability **Ghana** (add more
  countries later if you want).
- **Version 1.0.0 page:** iPhone 6.9" screenshots (1320 × 2868, at least 3:
  Home, a ride in progress, Account), description, keywords, support URL
  `https://campusride.app/support`, marketing URL `https://campusride.app`.
  Choose the build from TestFlight. **Export compliance** won't be asked (the
  build already answers it).

### 7. App Review information and the review demo

1. Turn the review demo on (Render → `campusride-server` → Environment; the
   four `REVIEW_DEMO_*` settings) exactly as in
   [review-notes.md](../store/review-notes.md#setting-it-up-owner-once-per-review),
   and try it once in each TestFlight app.
2. App Store Connect → each app → version 1.0.0 → **App Review Information**:
   _Sign-in required_ ✓, user name = the demo number, password = the 6-digit
   code, and paste the **Notes** for that app from review-notes.md. For the
   driver app, also add the background-location paragraph from
   [location-store-review.md](location-store-review.md#apple-app-store-connect--app-review-information--notes).
   Add your phone number and email as the contact.
3. **Submit for Review.** Answer Apple's "Advertising Identifier (IDFA)?"
   question **No**.
4. When both apps are approved: `REVIEW_DEMO_ENABLED=false` on Render.

### 8. After the apps are live

- Add `STORE_URL_RIDER_IOS` and `STORE_URL_DRIVER_IOS` on Render (each app's
  `https://apps.apple.com/…` page), so the "Time to update" screen can open
  the App Store ([releasing.md](releasing.md#forcing-people-off-an-old-build-time-to-update)).
- Don't set `MIN_VERSION_*_IOS` until a newer version is live on the App Store.

---

## Why Apple rejects ride and driver apps, and how CampusRide is covered

| Guideline                                                    | What gets apps rejected                                                                                                                                                                                                        | CampusRide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **5.1.1(ix)**, regulated services submitted by an individual | Apple wants apps in "highly regulated fields … or that require sensitive user information" to come from the **company** that provides the service, not a person. Ride-hailing and transport apps are sometimes caught by this. | **The one real risk of an Individual account; the code can't fix it.** In our favour: no payments in the app (cash only), no ID documents, licences or bank details collected, a campus-only service. Make sure the operator named in the Terms and Privacy Policy (the website's `operatorName`) is you, the same legal name Apple shows as the seller. If Apple rejects under 5.1.1(ix), the fix is to enrol (or migrate this account) as an **Organization**, which needs a registered business and a free D-U-N-S number (takes a few days to weeks), then resubmit. Apple may also ask whether you are allowed to run a transport service where you operate; answer plainly in the Resolution Center. |
| **2.1**, app completeness / reviewer can't sign in           | Reviewers can't get an SMS or a ride outside the service area, so they reject for "unable to sign in" or "no content".                                                                                                         | Review demo: fixed code, no SMS; the rider is treated as on campus; a simulated driver serves every ride; the demo driver is pre-approved and gets simulated requests (step 7). It runs on the server, so it behaves the same on iPhone and Android.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **2.1**, information needed                                  | Apple asks how drivers are vetted, where the service runs, and who pays whom.                                                                                                                                                  | Answer: drivers are approved by CampusRide (photo, car and plate checked) before they can go online; one university campus in Ghana; riders pay drivers cash, CampusRide takes a 15% commission from drivers outside the app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **5.1.1(v)**, account deletion                               | An app with sign-up must let people delete the account inside the app, not only deactivate it or email.                                                                                                                        | Account → **Delete account** in both apps: says what is deleted and kept, confirms with a texted code, then deletes (soft-delete at once, erased after 90 days). Also campusride.app/delete-account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **4.8**, Sign in with Apple                                  | Required only when an app offers third-party logins (Google, Facebook…).                                                                                                                                                       | Not needed: phone number and a one-time code is the only login.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **5.1.1(i)**, privacy policy                                 | No privacy policy link, or one that doesn't match the app.                                                                                                                                                                     | campusride.app/privacy, linked at sign-up (18+ and terms tick) and on Account; generated from data-inventory.md.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **5.1.1(ii)**, **5.1.5**, permission texts and location      | Vague texts ("needs your location"), library placeholders, asking for "Always" without a clear need, asking at launch.                                                                                                         | Specific texts above; placeholders replaced. Rider: "while using" only. Driver: asked only when going online, after a full-screen explanation; background location only while online; the blue indicator shows; stops when offline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **5.1.1(iv)**, forced permissions                            | The app refuses to work unless every permission is allowed.                                                                                                                                                                    | Rider can book with location off (search a place or drop a pin). Notifications are optional in both apps. A driver who allows only "While using" can still go online (told what that means). Only going online needs location at all, which is the job itself.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **2.5.4**, background modes                                  | Background modes the app doesn't really use (e.g. `fetch`, audio, silent push).                                                                                                                                                | Driver: `location` only (the `fetch` mode a library adds is removed). Rider: none. No `remote-notification`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **ITMS-91053**, privacy manifest                             | Uploads that use "required reason" APIs without declaring them get an email, then are refused.                                                                                                                                 | Manifest above, checked against every library's own manifest by a test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **5.1.2** / App Privacy labels                               | Labels that don't match what the app collects.                                                                                                                                                                                 | Use the table above (and data-inventory.md); over-declaring is safe, under-declaring is not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **3.1.1**, in-app purchase                                   | Digital goods must use Apple's payments.                                                                                                                                                                                       | Rides are a real-world service, which Apple exempts (3.1.3(e)); and there are no payments in the app.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **4.5.4**, push notifications                                | Pushes required for the app to work, or marketing without consent.                                                                                                                                                             | Only ride updates, asked after an explanation screen, never at first launch; the app works with them off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **4.2 / 4.3**, minimum functionality, duplicate apps         | Thin web-view apps; several near-identical apps.                                                                                                                                                                               | Two native apps with different jobs (rider / driver), which Apple accepts for marketplaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **2.3**, accurate metadata                                   | Screenshots that aren't the app, or iPad screenshots of a phone app.                                                                                                                                                           | iPhone-only; use real screenshots from TestFlight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **1.4**, physical harm / safety                              | Ride apps without any safety features get extra questions.                                                                                                                                                                     | SOS (alerts the emergency contact with a tracking link, and calls 112), driver photo, car and plate shown before pickup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
