# Testing Phase 2: the request board and the 7-minute window

This runs everything on your Mac against **phase2-test**, a copy of production
made on 25 Nov 2026 (Neon branch `phase2-test`, endpoint `ep-tiny-bread-bazvjtbb`).
Production is not touched, and nothing is merged.

- The copy holds real riders' and drivers' phone numbers and push tokens, so the
  local server runs with **texts, push notifications and payments switched off**.
  Login codes appear in the server's terminal instead of by SMS.
- Its address is only in `apps/server/.env.phase2-test`. That file is gitignored, so
  never commit it or paste it anywhere.
- Every Phase 2 command refuses to run against the production database
  (`ep-empty-violet-bay5yr3y`) or any database other than phase2-test.
- The fake riders use numbers that can't exist (+233099…) and names ending in
  "(test)". The cleanup step removes only those.

You need **three Terminal windows**: the server, Metro (the driver app's
JavaScript), and the fake riders. The app runs on your iPhone as a **development
build** of CampusRide Driver (Expo Go can't run it: the project is SDK 57, and
Expo Go on the phone is SDK 58).

---

## Step 0: Install the development build on your iPhone (once)

Do this once. Later sessions start at Step 1.

**0a. Developer Mode** (iOS 16 and later must have it for this kind of build). On
the iPhone, open **Settings → Privacy & Security → Developer Mode**, switch it
**on** and restart when asked. After the restart, tap **Turn On** and enter your
passcode. If you don't see Developer Mode, do 0b first: it appears once a
development profile is installed.

**0b. Register the iPhone.** In Terminal on the Mac, go to the driver app:

```bash
cd ~/Desktop/CampusRideApp/apps/driver
```

Start the registration:

```bash
npx -y eas-cli@24 device:create
```

Answer the questions:

1. "Would you like to use the campusride-gh account?": **Yes**.
2. "Do you want to log in to your Apple account?": **Yes**. Enter your Apple ID,
   password and the 2-step code (they go to Apple only).
3. Choose your Apple Team if asked.
4. "How would you like to register your devices?": **Website** (it shows a link
   and a QR code).

On the iPhone:

1. Point the **Camera** at the QR code on the Mac, or open the link in **Safari**.
2. Tap **Register**. Safari says the site wants to download a configuration
   profile: tap **Allow**, then **Close**.
3. Open **Settings**. Tap **Profile Downloaded** near the top (or go to
   **General → VPN & Device Management**).
4. Tap **Install**, enter your passcode, then tap **Install** twice more.
5. Safari opens again and says the device is registered. Back in Terminal, it
   shows your iPhone (give it a name such as "Ativor iPhone 14 Pro" if asked).

**0c. Build it in the cloud.** Still in `apps/driver`, start the iOS development build:

```bash
npx -y eas-cli@24 build --platform ios --profile development
```

Answer the questions:

1. Log in to your Apple account again if asked: **Yes**.
2. If asked to create or update the ad hoc provisioning profile: **Yes**.
3. If asked which devices to include: select your iPhone (space), then Enter.

It uploads the project and prints **Build details: https://expo.dev/accounts/campusride-gh/projects/campusride-driver/builds/…**.
That's the build page. The build takes about 15–25 minutes in the cloud. You can
close Terminal; it keeps going.

**0d. Install it.** When the build page says **Finished**, tap **Install** on it
from the iPhone's Safari, or scan its QR code with the Camera. Then tap **Install**.
The app appears on the Home Screen as **CampusRide Driver** (the development
build replaces the App Store app if it's installed). Open it once: if iOS says
"Untrusted Developer", go to **Settings → General → VPN & Device Management**,
tap the developer and **Trust**.

## Step 1: Get the branch (Terminal 1)

Go to the project:

```bash
cd ~/Desktop/CampusRideApp
```

Fetch the latest branches:

```bash
git fetch
```

Switch to the test branch. It's the request board plus the development build
setup, and it is never merged:

```bash
git checkout driver-dev-build
```

Install its packages (it adds `expo-dev-client`):

```bash
npm install
```

Rebuild the database client for this branch:

```bash
npm run db:generate --workspace apps/server
```

Make sure the test copy has this branch's database changes. They're already
applied, so this should say there's nothing to do:

```bash
npm run db:migrate:phase2 --workspace apps/server
```

## Step 2: Put the iPhone and the Mac on one network

Use the iPhone's **Personal Hotspot**. Its devices can always reach each other,
while many shared and campus Wi-Fi networks block devices from talking to each
other. That's why you saw two addresses before: 172.20.10.x is the hotspot,
10.107.x.x was the other Wi-Fi.

1. On the iPhone: **Settings → Personal Hotspot**, turn on **Allow Others to
   Join**.
2. On the Mac: click the Wi-Fi icon in the menu bar and choose your iPhone.

Do this before starting the server. If the server is already running, stop it
(Ctrl+C) and start it again after the Mac joins the hotspot.

## Step 3: Start the server against the test copy (Terminal 1)

```bash
npm run dev:phase2 --workspace apps/server
```

Wait for a line saying `phase2:guard OK — phase2-test branch`, then
`Server listening at http://…:3000`. Leave this window open: login codes appear here.

## Step 4: Check the iPhone can reach the server (Terminal 2)

In **Terminal 2**, go to the project:

```bash
cd ~/Desktop/CampusRideApp
```

Print the Mac's address on the hotspot. It should start with `172.20.10.`:

```bash
ipconfig getifaddr en0
```

Check that the server answers there from the Mac:

```bash
curl http://$(ipconfig getifaddr en0):3000/health
```

It should print `{"status":"ok","app":"CampusRide"}`.

**Now check from the iPhone.** In **Safari**, open `http://172.20.10.4:3000/health`,
using the address the Mac printed. You should see the same
`{"status":"ok","app":"CampusRide"}`. If Safari can't open it, the phone can't
reach the Mac. Check the Mac is on the iPhone's hotspot (not another Wi-Fi), then
run the last two commands again.

## Step 5: Start Metro for the development build (Terminal 2)

Tell the driver app which server to use: the Mac's hotspot address.

```bash
echo "EXPO_PUBLIC_API_URL=http://$(ipconfig getifaddr en0):3000" > apps/driver/.env.development.local
```

Start Metro on the **same** address, so Metro and the server can't disagree, with
a fresh bundle so the app picks up the server address:

```bash
REACT_NATIVE_PACKAGER_HOSTNAME=$(ipconfig getifaddr en0) npm run dev:driver -- --dev-client --clear
```

It shows a QR code and `Metro waiting on exp+campusride-driver://…` with the same
`172.20.10.x` address.

On the iPhone, open **CampusRide Driver** (the development build). Either:

- scan Metro's QR code with the **Camera** and tap the banner, or
- in the app's start screen, tap the server listed under **Development servers**
  (`http://172.20.10.x:8081`), or tap **Enter URL manually** and type it.

The first load takes a minute. Terminal 2 then prints
`[CampusRide] API server: http://172.20.10.x:3000`. If it says `api.campusride.app`,
stop Metro (Ctrl+C) and run the last two commands again.

## Step 6: Sign in as a driver

Your own driver account is in the copy, so use it.

1. In the app, sign in with **your own driver phone number**.
2. **No SMS is sent.** In **Terminal 1** (the server), find the line containing
   `DummyOtpService: OTP issued (dev only, code shown)` and type its `code` into
   the app.
3. **Not on campus at 5 AM?** Open the **Account** tab, find
   **DEVELOPER · FAKE LOCATION**, and pick a zone, for example *Pentagon Hostel*.
   The app now pretends to be there.
4. On **Home**, tap **Go online**.

If the copy says you owe commission and can't go online, use another approved driver
account you control, or tell me.

## Step 7: Fill the board with fake riders (Terminal 3)

Go to the project:

```bash
cd ~/Desktop/CampusRideApp
```

Start 12 fake requests over 4 minutes at Pentagon, JQB, Jean Nelson, Bani, Balme
and TF. `--open-now` opens CampusRide on the test copy, since 5 AM is outside
service hours:

```bash
npm run simulate:requests --workspace apps/server -- --count 12 --minutes 4 --open-now
```

Each request prints a line as it's made, for example
`✓ Ama (test)  Shared  GH₵7  Pentagon Block A → James Quartey Building`.
North ↔ South trips (Pentagon, TF or Bani ↔ Jean Nelson) show **GH₵9**.

To run another batch, clean up first (Step 9). Each fake rider can only have
one open request at a time.

## Step 8: Test the board (in the app)

1. **Pop-ups unchanged:** a request near you still pops up on Home for about
   20 seconds.
2. Open the new **Requests** tab. Every waiting request on campus is there,
   nearest first, and new ones appear without refreshing.
3. **Filters:** tap a pickup chip, for example "Pentagon Block A (2)". Drop-off
   chips for those requests appear, and tapping one narrows the list again.
   "All" resets.
4. **Cards:** each shows pickup → drop-off, Shared or Ride alone and its seats,
   the fare (GH₵7, GH₵9 or GH₵15), how long the rider has waited, and the
   distance from you.
5. **Several at once:** tick two or three Shared requests and tap
   **Add to my trip**. The trip opens with all of them. Then:
   - try ticking more than 4 riders: the bar says a car takes at most 4;
   - try a Ride alone request together with others: the bar says it must be taken
     on its own.
6. **During a trip:** go back to **Requests**. A line at the top shows your free
   seats. Requests that don't fit are greyed out with the reason, for example
   "Your car is full" or "Ride alone: needs an empty car". Filter to one pickup
   and add someone who fits.
7. **Already taken:** this needs a second driver phone signed in to the same Mac.
   Both tick the same request, one taps first. The other sees "1 was already
   taken" and the rest still go in.
8. **7 minutes:** leave one request alone. It stays on the board for 7 minutes,
   then disappears (the rider is told no driver was found).

## Step 9: Clean up (Terminal 3)

Remove every fake rider and their rides from the test copy:

```bash
npm run simulate:requests:cleanup --workspace apps/server
```

Stop the server and the app with **Ctrl+C** in Terminals 1 and 2.

Point the driver app back at production for normal use:

```bash
rm apps/driver/.env.development.local
```

## Afterwards

The development build replaced the App Store **CampusRide Driver** on your iPhone
(they're the same app). To drive for real again, delete the development build and
install CampusRide Driver from the App Store.

The phase2-test branch keeps costing a little Neon compute while it exists. When
you're done testing, delete it in the Neon console (project `withered-voice-05688596`,
branch `phase2-test`). Delete only **phase2-test**, never `production`.
