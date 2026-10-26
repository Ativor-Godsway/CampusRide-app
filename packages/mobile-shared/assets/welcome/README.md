# Welcome animation

The green hero of the welcome screen in both apps
(`src/auth/screens/WelcomeHero.tsx`): a car drives across campus and parks at
the Balme Library, under the CampusRide logo.

| File                           | What it is                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `welcome.json`                 | The designer's Lottie file ("splash screen v3.json"), unchanged: 1080 × 1920, 60 fps, 240 frames. Played once, then held on its last frame. |
| `welcome-end.png` (+ @2x, @3x) | Its last frame as a still: shown with Reduce Motion on, and on slow Android phones (under 3 GB of memory).                                  |

**Swapping in a new animation:** replace `welcome.json`, then render its last
frame again at 1296 × 2304 for `welcome-end@3x.png` (and 864 × 1536, 432 × 768
for @2x and @1x). If the logo, road or building moved, update the positions
at the top of `WelcomeHero.tsx` (`LOGO_TOP`, `BADGE_TOP`, `ROAD_TOP`, `DASH`):
they keep the road on the hero's bottom edge and the logo below the status bar.
Check with `npm run screens -- <name> --only welcome --device se` (also
`promax`, `android-small`).
