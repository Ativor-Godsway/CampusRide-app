# App illustrations (3D art)

Every 3D image in the rider and driver apps comes from this folder.

**Swap an image:** replace the PNG with a new one using the **same file name**. That's it. Reload the app.

**Add a new one:** put the PNG here, then add one line to `src/design/illustrations.ts`.

Guidelines:
- Transparent background (PNG).
- Square, about 512×512 px, with the object centered and a little empty space around it.
- Keep each file under ~250 KB.

| File | Where it shows |
|---|---|
| car-idle.png | Driver home when offline ("Ready when you are") |
| pin-radar.png | Driver home, waiting for requests (with pulse rings) |
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
| no-drivers.png | Rider "No drivers available" |
| safety-shield.png | Rider Safety screen |
| logo-mark.png | Logo on the sign-in screens (both apps) |

App icons live separately in `apps/driver/assets/` and `apps/rider/assets/` (`icon.png`, `adaptive-icon.png`).
