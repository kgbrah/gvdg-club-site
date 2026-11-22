# Member interface validation

The browser fixture runs the member app source with a synthetic account, bundled UI logic, and local API responses. It captures the same routes in custom blue at 390 px, light at 1280 px, and dark at 320 px with enlarged text. The script reads the member navigation registry so a new destination joins the capture set automatically.

```sh
CHROMIUM_PATH=/usr/bin/chromium node scripts/qa/member-subpages-browser-qa.mjs
```

Set `GVDG_MEMBER_SURFACE_IMAGES` to change the evidence directory. When previewing a checkout before the font assets land, `GVDG_VISUAL_FONT_PATH` can point to the local variable Archivo WOFF2. `GVDG_MEMBER_SURFACE_SERVE=1` keeps the fixture open for manual inspection.

| Destination | Controls and states to inspect |
| --- | --- |
| Home | Current round, starter checklist, membership, balance link, bag tag request and active holder actions, event and condition links, recent play |
| Play | Open scorecard, short code validation, join and watch destinations, course lookup, traffic, live cards, handicap, replay, practice and bag links |
| Course discovery | Search, accessibility filters, favorites and reset, loading/empty/error feedback, course detail and map links, review form and moderation status |
| Community | Profile and audience choices, disabled progress sharing in private mode, public link and revocation, progress history, friends, block/remove actions, directory search |
| Practice and My bag | Equal-width Putting, Fieldwork and My bag navigation, session and throw forms, record groups, draft and sync feedback, destructive action confirmation and cancel, private export |
| Events | Registered and open events, stable event deep link, fee and schedule, field, division/team and add-on selection, wallet and payment entry points, PDGA links and casual post form |
| League schedule and Event results | League route and season controls, results rows, season links, score and spectator destinations |
| Stats | Season summary, official PDGA rating, club estimates and evidence, personal history and filters, date error feedback, JSON/CSV downloads |
| Imported history | Keyboard-accessible CSV picker, imported score rows, remove actions, and confirmation |
| Club | Tool finder, grouped navigation, pro shop and club site links |
| Club directory | Member search and recognition, course-condition form and history, meeting minutes, active league information |
| Message board | Post composer, reply form, owner delete, loading/empty/error feedback |
| Tee signs | Course and hole selection, keyboard-accessible capture input, disabled upload, selected-photo preview and upload status |
| Bag tags and Club standings | Request and challenge actions, current tag status, team and league standings |
| Account and Wallet | Profile editor and image picker, passkey entry point, balance and transactions, Appearance, Devices and installation, support and logout |
| Appearance | Light and dark control, disc colors, wallpaper, color swatches, extraction and adjust controls, presets, apply/reset; studio toolbar remains in its own flow |
| Sign-in, application and temporary PIN | PIN validation, passkey entry, account application, error feedback, profile setup, signed-out casual link |
| Public community profile | Shared display, loading and unavailable states, member app link |
| Help and member dialogs | Open/close, focus, disabled send state, input and response, attachment action, confirmation buttons |

The suite checks all 21 registered destinations and runs representative nested interactions. These include keyboard navigation to the page heading, score and watch redirects, event registration and casual form controls, date validation, both private history downloads, Appearance layout, photo-picker focus, a tee sign upload, favorite and review controls, profile privacy, board replies, and a help message. Synthetic sign-in and account application use fixture accounts.

The live scorer, official result and rating behavior, backend permission checks, and browser installation support remain covered by their own suites. The local browser reports which synthetic UI flows ran. Platform passkey confirmation, hardware camera prompts, OS install behavior, real payments, assistant availability, and device pairing require their normal deployed or device environments.
