# Admin workspace verification

The browser fixture loads the real admin entry point against local test responses. It covers all entries in `ADMIN_DESTINATIONS` at 390 px, 320 px with 125% text in dark mode, and 1280 px. Each route checks that its populated content is visible and that horizontal scrolling stays within the appropriate control.

| Area | Destinations and controls |
| --- | --- |
| Today | Active event, check-in line, order handoff, waiting queues, alerts and live scorer shortcut |
| Events | Event list and filters, actions and status controls, new and repeat event form, CSV preview, league and league-night forms |
| Event workspace | Registration fees, divisions, team choices, club member and walk-on entry, cards, check-in, CTP and credits, live scoring, hole overrides, final leaderboard and event payments |
| Members | Members list, applications, add member and admin checkbox, temporary PIN dialog, role and wallet shortcuts |
| Money | Product inventory and new product form, sorting and stock, order tracking and status, wallet adjustment and ledger, campaigns |
| Courses and reviews | Course form and catalog, course health coverage and dated reports, maintenance task editor, layout builder and positions, tee-sign candidate review, course review moderation and discovery metadata |
| Club records | Bag-tag assignments and requests, challenges, meeting minutes, archive destinations, export options and download result |
| Tools and access | Toolbar discovery, keyboard search, Back, dock and sidebar, theme toggle, Help, non-admin and signed-out gates |

The fixture exercises CSV preview, event delete confirmation and Escape, check-in, registration save, temporary PIN copy, layout scrolling, maintenance task save, tee-sign rejection confirmation, review publication, order status save, wallet adjustment and archive download preparation. The event list gets separate loading, empty and failed responses. Destructive confirmations run against test responses. Live hardware and production services are outside this browser fixture.

Run `CHROMIUM_PATH=/usr/bin/chromium GVDG_ADMIN_SCREENSHOTS=/tmp/gvdg-admin-review node scripts/qa/admin-visual-polish-qa.mjs` from the repository root. The screenshot path and Chromium override are optional when a Playwright browser is installed.
