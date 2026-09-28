# App illustrations (3D art)

Every 3D image in the rider and driver apps comes from this folder.

**Swap an image:** replace the PNG with a new one using the **same file name**. That's it. Reload the app.

**Add a new one:** put the PNG here, then add one line to `src/design/illustrations.ts`.

Guidelines:
- Transparent background (PNG). Exception: `no-drivers.png` has an opaque pure-white (#FFFFFF) background, so only place it on a pure-white surface.
- Square, about 512×512 px, with the object centered and a little empty space around it.
  Non-square art is fine too (the cars are 720×540, 4:3): draw it with `<Illustration name="…" width={…} />` and the height follows the image's own shape.
- Keep each file under ~250 KB.
- Style: the realistic cars (`car-standard`, `car-shared`) and the older clay-style cars (`car-idle`, `car-full`) should never appear on the same screen.

| File | Where it shows |
|---|---|
| car-standard.png | Rider ride choice, "Ride alone" (720×540, realistic) |
| car-shared.png | Rider ride choice, "Shared" (720×540, realistic) |
| car-idle.png | Driver home when offline ("Ready when you are") |
| pin-radar.png | Driver home, waiting for requests; rider "Finding your driver". Just the pin: the rings are drawn by the `pulse` animation, not baked in |
| search-empty.png | Driver, no matching requests / no nearby shared requests |
| car-full.png | Driver, "Car is full" banner |
| trip-complete.png | Driver, trip finished |
| history-empty.png | Driver "Your rides" when empty |
| offline.png | Connection error (both apps) |
| driver-onboarding.png | Driver "Set up your profile" |
| car-topdown.png | Rider map, the approaching driver (front of car must point UP) |
| pin-pickup.png / pin-dropoff.png | Map pickup / drop-off markers |
| service-ride.png / service-food.png / service-courier.png | Rider home tiles |
| rides-empty.png | Rider "No rides yet" and empty recent destinations |
| no-drivers.png | Rider "No drivers available" (opaque white background: white surfaces only) |
| safety-shield.png | Rider Safety screen; safety tips on "Finding your driver" |
| logo-mark.png | Logo on the sign-in screens (both apps) |

App icons live separately in `apps/driver/assets/` and `apps/rider/assets/` (`icon.png`, `adaptive-icon.png`).
