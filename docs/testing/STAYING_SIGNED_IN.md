# Checking that you stay signed in

A ten-minute check on an iPhone, for both apps, that only **Log out** (or a
session the server has really ended) signs you out. Set up the server and the
apps as in [SOLO_TESTING.md](SOLO_TESTING.md) first: Terminal 1
`npm run dev:server`, the app in Expo Go or a development build.

Each step ends with **what you should see**. If you ever land on the
phone-number screen without tapping Log out, note the step: that's a bug.

## Rider app (fake driver: `npm run sim:driver`)

1. **Log out** (Account → Log out), then sign in again with your number.
   *Home.* This fresh sign-in is the case that used to break.
2. Book a ride. When the simulated driver finishes it, tap **Back to home** on
   the trip-complete screen. *Home, still signed in.*
3. Book another ride; while the fake driver is on the way, cancel it
   (**Cancel ride**, pick a reason). *Home, still signed in.*
4. Open **Rides**, open a past trip, go back. Open **Account**, go back to
   **Home**. *Never the sign-in screen.*
5. Mid-ride, swipe the app away (kill it) and open it again. *Back on the trip.*
6. Mid-ride, turn on **Airplane mode** for a minute, then off. *Still on the
   trip, still signed in; the map catches up.*
7. Stop the server (Ctrl-C in Terminal 1), kill the app, open it. *"Can't
   reach CampusRide — You're still signed in".* Start the server again; tap
   **Try again** (or wait). *Home.* (Not Airplane mode for this one: a
   development build loads its code from your Mac when it opens.)
8. Stop the server (Ctrl-C in Terminal 1) mid-ride, wait 30 s, start it again.
   *Still signed in; the trip carries on.*

## Driver app (fake riders: `npm run sim:riders`)

1. **Log out**, sign in again. *Home.*
2. Go online, accept a request. On the trip screen tap **←** (top left).
   *Home, with the trip banner. Tap it: back on the trip.*
3. Finish the trip; tap **Back to Home**. *Home.*
4. While a new request is showing, press **c** in the simulator's terminal
   (that rider cancels), then tap **Accept**. *"Not accepted… Taking you back
   to Home", then Home by itself.*
5. Repeat rider steps 5–8 (kill and reopen, Airplane mode, server restart)
   during a driver trip.
6. Lock the phone for a few minutes during a trip (location keeps running),
   unlock, open the app. *Still signed in, on the trip.*

## Signing out still works

- Account → **Log out**: the phone-number screen; reopening the app stays
  signed out.
