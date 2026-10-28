# CampusRide design spec (source: Claude design system, 2026-10-18)

Source: CampusRide design system and mockups (Claude).

Mockups: `docs/mockups/*.png` (390×844 @2x). Their prices are from before 2026-10-27 (05 and 07 show a GH₵5 shared fare, and "You saved GH₵10"): the shared fare is GH₵7 (`PRICING` in `packages/shared/src/pricing/pricing.ts`).

## Brand book

CampusRide is a ride-hailing service for the University of Ghana, Legon. Two apps share this system: **Rider** (students booking Shared or Ride-alone trips) and **Driver** (campus drivers accepting offers and collecting cash). The goal is the calm confidence of Bolt and Uber, in CampusRide's own forest green.

## Principles

1. **Map first.** Home, booking, waiting and trips all sit on the map. Content lives in a white bottom sheet (`BottomSheet`), never on a grey page of cards.
2. **One main action per screen.** Exactly one `Button` `primary` (green) or one `SlideToConfirm` is visible. Everything else is `secondary` (tonal), `neutral`, `text` or a round icon button.
3. **Numbers are the hero.** The fare, the ETA and today's earnings use the `display` style. Names use `title-3`. Labels never compete with the number.
4. **Quiet surfaces.** White `surface` everywhere; `surface-2` fills mark inputs and grouped info. Shadows only on things that float over the map (`shadow-float`, `shadow-sheet`).
5. **Calm safety.** SOS is never a big red button on every ride. It lives inside the Safety action and opens its own sheet.

## Voice and copy

- Plain English, short sentences, sentence case: "Request Shared", "Pick up Kwame", "Go online".
- Speak to the person as **you**. Use first names: "Kwame is 2 min away".
- Money is always `GH₵` with no space and no decimals for whole cedis: `GH₵15`, `GH₵12.75`.
- Times as "2 min", "about 3 min". Distances as "400 m", "1.6 km".
- Buttons start with a verb and say what happens: "Cancel ride", not "Yes". Destructive actions say what is lost: "Delete account".
- Errors say what went wrong and what to do: "That code didn't match. Check the SMS and try again."
- No exclamation marks, no emoji in UI copy, no "Oops".

## Colour

- Brand: `green-500` for the primary button, selected borders, route line (`map-route`), pickup pin and links. Pressed: `green-600`. Text on it: `on-brand`.
- Tonal: `green-50` fill with `green-700` text for secondary buttons, the selected ride option and the Recommended chip.
- Accent: `amber-400` only for rating stars, the DRIVER badge and the live pulse. Text on amber is `ink`. Never an amber button.
- Text: `ink` (primary), `ink-2` (secondary), `ink-3` (placeholder/caption). `ink-4` is for disabled icons only.
- Status: warning = `amber-50` + `amber-700`; danger = `red-50` + `red-600`. Every status also carries a word or icon, never colour alone.
- Dark: `surface-dark` with `on-dark` / `on-dark-2` / `green-on-dark` for the toast, cash-collected card and driver earnings hero. Use at most one dark block per screen.
- The apps ship a light theme only for launch. Maps stay light.

## Type

- One family: **Figtree** (Google Fonts, OFL), weights 400–800. Load it with `@expo-google-fonts/figtree` through the `expo-font` config plugin so it is embedded in the store build. Fallback: the system font.
- Scale: `display` 40 · `title-1` 28 · `title-2` 22 · `title-3` 18 · `body` / `body-strong` 16 · `button` 17 · `subhead` 14 · `caption` / `eyebrow` 12. Don't invent in-between sizes.
- All money, ETAs, countdowns and OTP digits use tabular numerals (`fontVariant: ['tabular-nums']`).
- Plates use the `plate` style inside a white frame with a 1.5px `ink` border and `radius-sm`, so a rider can match it to the real plate.
- Support Dynamic Type up to 1.3× (`maxFontSizeMultiplier={1.3}` on display sizes so big numbers don't break layouts).

## Space, radius, elevation

- 4px grid. Screen gutter and sheet padding: `space-5` (20). Card padding: `space-4`. Between sections: `space-6`.
- Radii: controls `radius-md` (14), cards `radius-lg` (20), sheets `radius-xl` (28), chips and round buttons `radius-full`.
- Heights: `control-lg` 56 for main buttons and inputs, `control-md` 48 minimum touch target, `control-sm` 36 for chips (hit slop to 48).
- Focus: `focus-ring` on anything focusable.

## Motion and haptics

- Press: every tappable scales to 0.97 over 120 ms (Reanimated spring, damping 18). No opacity-only presses.
- Sheets: spring to snap points (`@gorhom/bottom-sheet`, damping 22, stiffness 220). Content inside fades/slides 8px over 220 ms.
- Lists: rows fade up 8px, staggered 30 ms, first appearance only.
- Numbers: fares and earnings count up over 600 ms on trip complete.
- Live states: the searching pulse is 2 rings expanding over 1.6 s at pickup; the Online dot breathes.
- Haptics (`expo-haptics`): `selection` on chip/option change; `impactLight` on primary press; `impactMedium` when a slide-to-confirm completes; `notificationSuccess` on trip complete and driver found; `notificationWarning` on SOS open and wrong OTP; `notificationError` on a failed request.
- Respect Reduce Motion (`useReducedMotion`): swap movement for fades, stop pulses.

## Iconography

- Ionicons (already in both apps): outline at 24px for UI, filled only for the active tab and selected states. Stroke icons are `ink`; inside a `green-50` tile they are `green-700`.
- Map pins are the 3D renders in the Illustrations group (`pin-pickup.png`, `pin-dropoff.png`), never Ionicons.

## Imagery

- One style only: realistic studio renders of the forest-green CampusRide car on white or transparent (`car-standard.png`, `car-shared.png`). The toy "clay" art has been removed from the apps (PR 12).
- The same car model appears everywhere: `car-standard.png`, `car-shared.png`, `car-topdown.png` and `no-drivers.png` are all the same green sedan.
- Illustrations top out at 160pt wide in sheets and 220pt on full-screen empty states.

## Layout patterns

- **Map screen:** map full-bleed; floating `shadow-float` pills top (back + route) and right (recentre); `BottomSheet` at the bottom with 2–3 snap points.
- **Sheet anatomy:** handle → optional `eyebrow` → `title-2` → content → one primary action pinned to the bottom with safe-area padding.
- **Lists:** `ListRow` on `surface` with inset `line` dividers. Group with a `title-3` header, not a card.
- **Empty states:** illustration, `title-2`, one `body` line in `ink-2`, at most one button.

## Accessibility

- Text pairs meet 4.5:1 (see each colour's note); meaningful borders and icons meet 3:1.
- Every control is at least 48×48. Icon buttons carry an `accessibilityLabel`.
- Disabled buttons use `surface-3` + `ink-3` (not pale green) and say why nearby ("Tick the box to continue").

## In the code

Tokens live in `packages/mobile-shared/src/design/tokens.ts`; components in `packages/mobile-shared/src/design/components/`. This system is the source for those values; a change here is made in that file in the same PR.

## Tokens (exact values)

### Colour (light theme only)

| token | value | use |
|---|---|---|
| `surface` | `#ffffff` | Page and sheet background in both apps. Map-first screens put white sheets on the map; list screens are white, not grey. |
| `surface-2` | `#f2f4f3` | Filled inputs, OTP boxes, neutral buttons, grouped info cards, icon tiles. Never a whole-page background. |
| `surface-3` | `#e5e9e7` | Pressed neutral controls, skeleton shimmer, disabled button fill. |
| `line` | `#e6eae8` | Hairline dividers between list rows and inside cards (decorative, no contrast floor). |
| `line-strong` | `#7a8480` | Borders that carry meaning: unselected radio/checkbox outlines, the phone prefix divider. 3.5:1 on surface-2, 3.9:1 on surface. |
| `ink` | `#0f1311` | Primary text and icons on surface, surface-2 and green-50. Also the dark fill of filter chips when selected. |
| `ink-2` | `#4a5350` | Secondary text: subtitles, helper text, metadata, on surface and surface-2 (7.9:1 on white). |
| `ink-3` | `#646d69` | Tertiary text: placeholders, captions, timestamps, on surface and surface-2 only (4.8:1 on surface-2). |
| `ink-4` | `#a3aba8` | Disabled icons and inactive tab icons. Never body text. |
| `green-50` | `#e8f3ec` | Tonal button fill, selected ride-option fill, success toast-free confirmations, pickup chip. |
| `green-100` | `#cde6d6` | Progress-bar track, slide-to-confirm track, pressed tonal button. |
| `green-500` | `#19743c` | THE brand green: primary buttons, selected borders, the route line, pickup pin, links. 5.9:1 on white. |
| `green-600` | `#115c2f` | Pressed state of primary buttons. |
| `green-700` | `#0f5429` | Green text on green-50 and on surface (labels of tonal buttons, Recommended chip, prices on a selected card). |
| `on-brand` | `#ffffff` | Text and icons on a green-500 or green-600 fill. |
| `green-on-dark` | `#7be0a0` | Green accents on a dark surface: Online dot, live pulse, earnings deltas. 11.6:1 on surface-dark. |
| `amber-400` | `#ffbb29` | Accent, used sparingly: rating stars, the DRIVER badge, the car dot in the logo, the live 'searching' pulse core. Text on it is ink. |
| `amber-50` | `#fbf0da` | Warning surface: out-of-area notice, 'Waiting' status chip. |
| `amber-700` | `#7a5310` | Text on amber-50 (6.0:1). |
| `red-600` | `#b42318` | Danger text and borders: Cancel ride, Delete account, OTP error, SOS label. 6.5:1 on white. |
| `red-50` | `#fdecea` | Danger surface: error notice, SOS sheet background. |
| `surface-dark` | `#0f1311` | Dark feature surfaces: toast, driver earnings hero, cash-collected card, the driver Online bar. |
| `surface-dark-2` | `#1c2220` | Raised element on surface-dark (a pill or row on the earnings hero). |
| `on-dark` | `#ffffff` | Primary text on surface-dark. |
| `on-dark-2` | `#a9b3af` | Secondary text on surface-dark (8.7:1). |
| `scrim` | `rgba(15,19,17,0.45)` | Dims the map or screen behind a modal sheet (cancel, SOS, rating). |
| `map-land` | `#eef0ea` | The map's base tint; mockups use it behind sheets. Matches Apple/Google light map land. |
| `map-route` | `{green-500}` | Route polyline on the map: an alias of the brand green. Upcoming legs on a multi-stop trip use it at 35% opacity. |

### Type (Figtree)

| style | size/line | weight | tracking | use |
|---|---|---|---|---|
| `display` | 40px/44px | 800 | -0.03em | One per screen: the fare on trip complete, the ETA on driver-on-the-way, today's earnings. Tabular numerals. |
| `title-1` | 28px/34px | 800 | -0.02em | Screen titles and the main sheet question. |
| `title-2` | 22px/28px | 700 | -0.01em | Sheet titles and empty-state headlines. |
| `title-3` | 18px/24px | 700 | 0 | Card titles, driver and rider names, ride option names. |
| `body` | 16px/24px | 400 | 0 | Paragraphs and descriptions. |
| `body-strong` | 16px/22px | 600 | 0 | List row titles, place names, input values. |
| `button` | 17px/22px | 700 | 0 | Labels on large and medium buttons. |
| `subhead` | 14px/20px | 500 | 0 | Row subtitles, helper text, metadata. |
| `caption` | 12px/16px | 600 | 0.01em | Chips, timestamps, map attribution, tab labels. |
| `eyebrow` | 12px/16px | 700 | 0.08em | Uppercase section labels above a title. Max one per card. |
| `plate` | 20px/24px | 800 | 0.06em | Licence plates only, inside the plate frame (white fill, ink 1.5px border, radius-sm). |

### Spacing

| token | value | use |
|---|---|---|
| `space-1` | `4px` | Icon-to-label gap inside chips. |
| `space-2` | `8px` | Gap between chips, OTP boxes, stacked caption lines. |
| `space-3` | `12px` | Gap between buttons in a stack and between related rows of a card. |
| `space-4` | `16px` | Card and input inner padding; list row horizontal padding. |
| `space-5` | `20px` | Screen side gutter and bottom-sheet padding. |
| `space-6` | `24px` | Between sections inside a sheet. |
| `space-8` | `32px` | Above a screen title; between major blocks. |
| `space-10` | `40px` | Empty-state top padding; space above a full-screen hero number. |

### Radius

| token | value | use |
|---|---|---|
| `radius-sm` | `8px` | Plate frame, status chips, small thumbnails. |
| `radius-md` | `14px` | Buttons, inputs, OTP boxes, toasts. |
| `radius-lg` | `20px` | Cards and ride options. |
| `radius-xl` | `28px` | Top corners of bottom sheets and full-screen offer cards. |
| `radius-full` | `999px` | Chips, round icon buttons, avatars, the slide-to-confirm track, map pills. |

### Shadow

| token | value | use |
|---|---|---|
| `shadow-float` | `0 2px 6px #0f13111a, 0 8px 24px #0f131114` | Map pills (route pill, recentre button, Go online button) and the toast. |
| `shadow-sheet` | `0 -6px 28px #0f13111f` | Bottom sheets sitting on the map. |
| `focus-ring` | `0 0 0 2px #ffffff, 0 0 0 4px #19743c` | Keyboard / switch-control focus: 2px white gap then 2px brand green. |

### Size

| token | value | use |
|---|---|---|
| `control-lg` | `56px` | Primary and secondary buttons, inputs, OTP box height. |
| `control-md` | `48px` | Buttons inside cards, the minimum touch target. |
| `control-sm` | `36px` | Chips and small pill buttons (hit area padded to 48). |
| `icon-button` | `56px` | Round action buttons (Call, Message, Share, Safety). |
| `icon` | `24px` | Default icon size; 20px inside chips and rows' trailing slot. |
| `avatar` | `56px` | Driver / rider photo on trip cards; 40px in lists. |

(React Native shadows: translate `shadow-float` to iOS shadowOpacity 0.10 / radius 12 / offset y 4 + Android elevation 4; `shadow-sheet` to opacity 0.12 / radius 14 / offset y -6 + elevation 12. Letter-spacing em → px: multiply by font size.)

## Components

### Button

The one style for every tappable action, with a strict order: one `primary` per screen, then `secondary`, `neutral`, `text`, `danger`.

**Consumer provides:** `label` (verb first, sentence case), `variant`, optional `size` (`lg` 56 default, `md` 48, `pill` 36), optional leading `icon`, `loading`, `disabled`, `onPress`.

- `primary`: `green-500` fill, `on-brand` label. Exactly one per screen (the thing the screen is for).
- `secondary` (tonal): `green-50` fill, `green-700` label. Alternatives like "Switch to Ride alone".
- `neutral`: `surface-2` fill, `ink` label. Back, Close, Edit profile.
- `text`: no fill, `green-700`. Skip, Resend code.
- `danger`: no fill, `red-600`. Cancel ride, Delete account. Never a red filled or red outlined button.
- `go`: the driver's 64px pill "Go online" / "Go offline", floating on the map with `shadow-float`.
- **Round action** (`IconButton`): 56px `surface-2` disc + `caption` label below: Call, Message, Share trip, Safety. Always has an `accessibilityLabel`.
- Disabled: `surface-3` fill, `ink-3` label, with the reason written nearby.
- Press: scale 0.97 (Reanimated), `impactLight` haptic on primary.

Don't: outline buttons, green glow shadows, two green buttons stacked, or full-width text buttons.

In code: `packages/mobile-shared/src/design/components/Button.tsx`. The old names `ghost` and `dangerSecondary` still work and render as `text` and `danger`.

### SlideToConfirm

A full-width 64px slider for the driver's irreversible trip steps (picked up, cash collected, trip ended), so they can't be triggered by a stray tap while driving.

**Consumer provides:** `label` ("Slide when Kwame is in"), `onConfirm`, optional `tone` (`brand` default, `dark` for the cash step), `doneLabel`.

- Track `green-100`, knob 56px `green-500` with an arrow; the fill follows the knob.
- Past 85% it snaps to done: `impactMedium` haptic, fill turns `green-500`, label becomes `doneLabel` with a check.
- Under 85% it springs back.
- Accessibility: also completes on a long-press of 600 ms and exposes an `accessibilityActions` "activate", so it works with VoiceOver/TalkBack.
- One per screen, and it IS the primary action: no green button next to it.

In code: `packages/mobile-shared/src/design/components/SlideToConfirm.tsx`.

### Input

Filled text fields: `surface-2` at rest, white with a 2px `green-500` border when focused, `red-600` border on error.

**Consumer provides:** `label` (above, `ink-2` 14/600), `value`, `onChangeText`, optional `placeholder` (`ink-3`), `helper`, `error`, `prefix`, `keyboardType`, `textContentType` / `autoComplete`.

- Height `control-lg` (56), radius `radius-md`, value 17/600 `ink`.
- **Phone:** fixed prefix (Ghana flag + "+233", divider `line-strong`), digits formatted as `54 860 8146` while typing, `textContentType="telephoneNumber"`, `autoComplete="tel"`. Accept a pasted "054…" or "+233…" and normalise.
- **Search (rider home):** `surface-2` bar with a search icon and the `title-2`-weight prompt "Where to?". It opens the plan screen; it isn't typed into on the map.
- **Checkbox row:** the whole row is tappable; 24px box with `line-strong` border, `green-500` when on.
- Errors sit under the field with an alert icon and say how to fix it.

Don't: grey outlines at rest, placeholder-as-label, red text without an icon.

### OtpInput

Six separate digit boxes backed by ONE hidden `TextInput`, with SMS autofill and auto-submit on the sixth digit.

**Consumer provides:** `value`, `onChange`, `onComplete(code)`, `error`, `verifying`.

- Boxes 56px tall, `radius-md`, `surface-2`; the active box is white with a `green-500` border and a blinking caret.
- Digits 26/800 tabular `ink`.
- **Autofill:** the hidden input sets `textContentType="oneTimeCode"` (iOS shows "From Messages" above the keyboard) and `autoComplete="sms-otp"` (Android shows the code suggestion). `keyboardType="number-pad"`, `maxLength={6}`.
- **Paste:** pasting 6 digits fills every box.
- **Auto-submit:** on the 6th digit call `onComplete` at once; no Continue button on this screen.
- **Wrong code:** boxes turn `red-50` / `red-600`, shake 3 times (8px, 300 ms), `notificationWarning` haptic, then clear and refocus.
- **Verified:** boxes turn `green-50` / `green-700` for 400 ms before moving on.
- Resend: `text` button, disabled with a `0:41` countdown in tabular numerals.
- Android SMS Retriever (fully automatic, no tap) would need a native library; the autofill above needs none.

### Card

Cards group related facts with a FILL, not a shadow: `surface-2` on white pages, `surface` with `shadow-float` only when floating on the map, `surface-dark` once per screen for a hero number.

**Consumer provides:** children; for a ride option: `image`, `title`, `subtitle`, `price`, `selected`, optional `badge`.

- Radius `radius-lg` (20), padding `space-4`.
- **Ride option:** car render 96×72 left, `title-3` name + optional status chip, `subhead` "3 min · up to 4 riders", price 20/800 right. Selected: `green-50` fill + 2px `green-500` border, price turns `green-700`. Unselected: no fill, no border. `selection` haptic on change.
- **Driver card (rider side):** 56px avatar with an amber-star rating badge, first name `title-3`, car colour and model `subhead`, plate in the plate frame (`plate` style).
- **Dark feature card:** `eyebrow` in `green-on-dark`, the `display` number in `on-dark`, key/value rows in `on-dark-2`.

Don't: cards inside cards, a card around a single list, shadows on white.

### BottomSheet

The white sheet that holds every map screen's content, built on `@gorhom/bottom-sheet` (already installed) with snap points, a handle and a pinned action.

**Consumer provides:** `snapPoints` (e.g. `['35%', '70%']`), children, optional `footer` (the primary action), `modal` (true for confirm sheets).

- `surface`, top corners `radius-xl` (28), `shadow-sheet`, handle 36×5 `surface-3`, padding `space-5`.
- Anatomy: handle → optional `eyebrow` → `title-2` → content → footer pinned above the safe area.
- Map sheets have no scrim and the map stays interactive. Modal sheets (cancel, SOS, rating) dim the screen with `scrim` and close on tap-outside unless the action is required.
- Never stack a sheet on a dimmed sheet: replace the content in place.
- Keyboard: use `BottomSheetTextInput` with `keyboardBehavior="interactive"` so the sheet rises above the keyboard (fixes the hidden note field).
- Floating map controls (route pill, recentre) sit above the sheet and move with it.

In code: `packages/mobile-shared/src/design/components/BottomSheet.tsx` (the Modal-based `Sheet.tsx` is gone).

### ListRow

Flat 64px rows on `surface` with inset `line` dividers. Use them for places, settings, stops and history instead of stacking cards.

**Consumer provides:** `title`, optional `subtitle`, `leading` (icon, avatar or stop number), `trailing` (chevron, value, status chip), `onPress`, `tone` (`default` / `brand` / `danger`).

- Leading tile 40px circle `surface-2` with a 24px `ink` icon; `brand` tone = `green-50` + `green-700`; `danger` = `red-50` + `red-600` with a red title.
- Title `body-strong`, subtitle `subhead` `ink-2`, trailing `ink-3` or an amount in `ink`.
- Divider starts after the leading tile (inset 56) and is hidden under the first row.
- Section headers are `title-3` text above the list, not a card.
- Stop numbers: green circle for pickups, ink rounded square for drop-offs (matches the map pins).
- Press: `surface-2` highlight + scale 0.99.

### Chip

Compact pills for filters, single/multi choice, recent places and status.

**Consumer provides:** `label`, `selected`, optional `icon`, `onPress`; status chips take `tone`.

- **Filter** (36px): `surface-2` + `ink`; selected = `ink` fill + white text. One selected at a time (All / Shared / Private).
- **Choice** (36px): `surface-2`; selected = `green-50` + 1.5px `green-500` border + `green-700` text and a check. Cancel reasons, car makes on driver onboarding. (Rating tags wait for the rating API to take tags.)
- **Place** (36px): white with a `line` border and a clock icon; recent destinations on rider home.
- **Status** (24px, `radius-sm`, 12/700): `brand` Best value / Online / In car; `neutral` Shared · 1 seat; `warn` Waiting / Under review; `danger` Cancelled; `amber` DRIVER badge. Always a word, never a bare dot.
- `selection` haptic on change. Hit area padded to 48.

### Toast

A short dark message that slides down from the top for 3 seconds to confirm something that already happened. Problems that need fixing use an inline notice instead.

**Consumer provides:** `message`, optional `subtitle`, `icon`, `action` (label + handler), `tone` (`success` / `info` / `warning`, which only changes the icon colour).

- `surface-dark`, `radius-md`, `shadow-float`, 15/600 `on-dark`; icon `green-on-dark` or `amber-400`; action text `green-on-dark`.
- Position: under the status bar, above any sheet and never covering a button (fixes "Kwame is in the car" covering Add rider).
- One at a time; a new one replaces the old. Swipe up to dismiss. Announced to screen readers.
- **Inline notice:** `amber-50` / `amber-700` (warning) or `red-50` / `red-600` (error), `radius-md`, icon + one sentence that says how to fix it. Stays until the problem is fixed (e.g. out-of-area pickup).

## Rules settled during the redesign (PRs 2–12)

What the mockups didn't say, or what changed once real data and real phones were involved. They are as binding as the rest of this spec.

**Real data only**
- Never invent a number. No ETA until there is a driver position ("On the way" instead of minutes); no "Online" time on the driver's trip-complete card (it isn't tracked); no distance on it either.
- "Current location" is never a place name in a sentence: say the place it resolves to ("Asking drivers near Akuafo Hall"), else "near you" / "Meet at your pickup point".
- Phone numbers are shown formatted: "+233 54 860 8146".
- Driver money has ONE rule (`earningsTotals` in @rida/shared, used by the server's all-time summary and the app alike): **Gross** = the fares riders paid; **Commission** = CampusRide's 15% of them; **After commission** = the sum of the driver's 85% shares, the "You earn" amounts. The commission comes out once. "Today" is after commission everywhere: the Home pill, the trip-complete card and the Earnings tab show the same number.

**Rider**
- Cancelling swaps the ride sheet's content in two steps (confirm, then a reason); never a second sheet.
- The Safety button opens its own modal sheet with two separate actions: "Alert my emergency contact" (the SOS text and link, after a confirm, success toast) and "Call emergency services (112)", a red-50 / red-600 button 56 tall that dials and sends the same alert. Without a contact the first row is "Add an emergency contact". A warning haptic when the sheet opens.
- Trip complete and a cancelled trip are one modal sheet over the dimmed map.
- Pushed screens (Profile, Safety, Notifications, Delete account, Licences) start with the 44px round Back (`BackButton`, `IconButton` variant `compact`): they have no navigation header.

**Driver**
- Going online asks for location only then; if location isn't allowed or asking fails (e.g. "Always" in a store build), the driver stays offline, the server is never told otherwise, and Home shows an inline notice with Open Settings.
- A new request is a full-screen takeover over everything (`RequestTakeover`): map on top, white panel with the countdown ring, the 48px fare, "You earn", the stops card, a 64px Accept whose green-600 fill runs down with the countdown, Decline as text. Accept waits for the server: a spinner, then the trip (success haptic), or a toast ("That request was taken" / "That request expired"), or an inline error with Try again. While Accept is waiting the countdown stops. Adding a rider to a shared trip uses the same takeover, with the server's detour as "Fits your route · +2 min".
- The trip screen has ONE big control, the slider ("Slide when Kwame is in", the dark "Slide when you have GH₵15" under "Collect GH₵15 cash"). Navigate, Call, Message and Stops are round buttons; everything else (I'm here, Add a rider, Stops, Cancel pickup, Rider didn't show, the dev-only fake drive) lives in the ⋯ menu. "I'm here · tell Kwame" appears above the slider within the automatic-arrival distance; once arrived, a "Waiting · 1:42" chip, and "Rider didn't show" after 3 minutes.
- Trip complete and "This trip has ended" are white pages with a 60px badge in an 84px ring (green check, or grey), and one button at the bottom ("Find next trip", which goes back online if needed, or "Back to Home").
- Onboarding: two steps with a progress bar, one primary button pinned at the bottom, and ONE "Use a different number" at the bottom of the page. Plates are formatted as typed ("GR 1234-24").

**Maps**
- The driver's car is `car-topdown.png` at 44px (nose up = north), facing its direction of travel: along the road where it is on the drawn route, otherwise the way it moved since the last GPS fix, and it stays put for moves under 3 m. It glides about a second to each fix and turns the short way round over the same glide (with Reduce Motion on it jumps and turns in one step). On iPhone the image itself is turned, minus the map's own rotation (Apple Maps ignores a marker's rotation); on Android the native marker is rotated. Logic in [`heading.ts`](../packages/shared/src/geo/heading.ts), drawn by `CarMarker`.
- The searching / online pulse is PulseRings' look drawn as map circles, so it stays on the point as the map moves.
- On the trip map only the leg to the next stop is bold green-500 (6px); later legs are green at 35%. Before Accept, places are drawn at their campus zones: the server sends no exact pins or rider notes then.

**Components added**
- `SegmentedControl` (Today / This week), `BackButton`, `IconButton` variant `compact`, `OpenSourceLicensesScreen` (Account → Open-source licenses in both apps).
- Chart bars: today's `green-500`, the other days `chartBar` (validated against green-500 for normal and colour-blind vision; under 3:1 on white, so the bars always carry labels).

## Screens (mockups in docs/mockups/)

| file | screen | key points |
|---|---|---|
| 01-rider-welcome.png | Welcome (both apps; driver adds the amber DRIVER badge) | green hero, now the CampusRide animation (`assets/welcome/`, played once, last frame still with Reduce Motion) instead of the car, ONE button "Continue with phone number", terms line |
| 02-rider-phone.png | Phone | fixed Ghana flag + "+233" prefix, digits formatted as typed, accepts pasted 054…/+233…, "Send code" above keyboard |
| 03-rider-code.png | OTP | 6 boxes, iOS "From Messages" / Android sms-otp autofill, auto-submit on 6th digit, no Continue button, "Resend in 0:41" |
| 04-rider-home.png | Rider home | full map, "Where to?" sheet, recent-place chips, slim "Food and courier · Soon" row, tabs Home/Rides/Account |
| 05-rider-choose-ride.png | Choose a ride | floating back + route pill, two ride options (selected = green-50 + green border), chips Cash / Exact pickup / Note, one "Request Shared" button |
| 06-rider-driver-on-the-way.png | Driver on the way / in ride | eyebrow + display "3 min", driver card (avatar + amber rating, plate frame), round Call/Message/Share trip/Safety, "Cancel ride" red text; SOS lives inside Safety |
| 07-rider-trip-complete.png | Trip complete + rating | one modal sheet: arrived, display fare + "Pay Kwame in cash", shared-savings chip, avatar, 5 amber stars, Done (tag chips not built: POST /ratings takes stars and a comment only) |
| 08-driver-home-offline.png | Driver home offline | full map + top-down car, "Today GH₵0.00" pill, 64px "Go online" pill, short offline sheet, tabs Home/Earnings/Account |
| 09-driver-home-online.png | Driver home online | pulse rings around the car, dark "Today GH₵17.50 · 2 trips" pill, sheet "Finding trips near you", filter chips, "Go offline" pill |
| 10-driver-ride-offer.png | Ride offer | full takeover over map (route to pickup dashed, trip green), countdown ring, huge fare + "You earn", pickup/drop-off card, 64px Accept pill with countdown fill, Decline text |
| 11-driver-trip.png | Trip | back + "type · fare" pill + ⋯ menu (I'm here, Cancel pickup, Add rider live there), sheet: eyebrow + "Pick up Kwame", rider note, round Navigate(green)/Call/Message/Stops, ONE slider |
| 12-driver-trip-complete.png | Driver trip complete | check badge, dark cash-collected card, Today/Trips stats ("Online" time isn't tracked, so it's left out), rate rider stars, "Find next trip" |
