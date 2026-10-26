# App illustrations (3D art)

Every 3D image in the rider and driver apps comes from this folder.

**Swap an image:** replace the PNG with a new one using the **same file name**. That's it. Reload the app.

**Add a new one:** put the PNG here, then add one line to `src/design/illustrations.ts`.

Guidelines:
- Transparent background (PNG). Exception: `no-drivers.png` has an opaque pure-white (#FFFFFF) background, so only place it on a pure-white surface.
- Square, about 512×512 px, with the object centered and a little empty space around it.
  Non-square art is fine too (the cars are 720×540, 4:3): draw it with `<Illustration name="…" width={…} />` and the height follows the image's own shape.
- Keep each file under ~250 KB.
- Style: realistic 3D renders (docs/design-system.md, "Iconography"). The older clay-style art was removed in the redesign.

| File | Where it shows |
|---|---|
| car-standard.png | Rider ride choice, "Ride alone"; empty states and sign-in screens (720×540, realistic) |
| car-shared.png | Rider ride choice, "Shared" (720×540, realistic) |
| car-topdown.png | The driver's car on every map (front of car must point UP) |
| pin-pickup.png / pin-dropoff.png | Map pickup / drop-off markers |
| no-drivers.png | Rider "No drivers available" (opaque white background: white surfaces only) |
| safety-shield.png | Rider Safety screen |
| logo-mark.png (+ @2x, @3x) | The green CampusRide mark on the white loading screen (both apps), 72 pt. Made by `scripts/brand/generate.py` from `assets/brand/logo-green.png`: re-run it rather than editing by hand |

App icons live separately in `apps/driver/assets/` and `apps/rider/assets/` (`icon.png`, `adaptive-icon.png`).
