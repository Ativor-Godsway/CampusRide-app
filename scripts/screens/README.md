# Screenshots without a phone

```sh
npm run screens -- pr-03                  # every scene, both apps
npm run screens -- pr-03 --app driver     # one app
npm run screens -- pr-03 --only home,trip # some scenes
npm run screens -- pr-03 --device se      # iPhone SE size (also promax, android-small)
```

PNGs, 390 px wide at 2x, are saved to
`~/Desktop/CampusRide UI audit/pr-screens/<name>/` as `<app>-<scene>.png`.
Pass `--out <dir>` to save them somewhere else. The PNGs are never committed.

The first run installs its own tools (react-native-web, esbuild,
puppeteer-core) into `node_modules/.cache/campusride-screens`. It uses the
Google Chrome already on the Mac; set `CHROME_PATH` to use another browser.

## What it is

The apps' real route files, root layouts included, rendered by
react-native-web in headless Chrome:

- `stubs/` stands in for what only exists on a phone. Maps are a grey box, the
  bottom sheet is a still panel, and the native modules behave like a phone
  with every permission granted.
- `harness/data.ts` is made-up data: real campus places, invented people.
- `harness/core.tsx` is a fake server answering the app's API calls.

This shows layout, type and colour. It is not a phone: native shadows, the
keyboard, gestures, the status bar and maps look different on a device.

## Adding a scene

Add an entry to `harness/rider.tsx` or `harness/driver.tsx`:

- `chain`: the route files to render, root layout first and the screen last.
- `user`: who is signed in (`null` for signed out).
- `routes`: the fake server's answers, as `"GET /path": body`.
- `params`: the screen's route params.

When a screen asks for something the fake server doesn't know, the run prints
`no fake answer for GET /…`. Add that path to `routes`.
