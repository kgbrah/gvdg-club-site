# Whole-app polish coverage

The user approved the revised Member Home direction and explicitly requested every page, button and section, with the scorecard receiving the deepest appearance and behavior review. Approval includes implementation and GitHub deployment, including the revised bottom-control scorecard direction approved after two rejected iterations. Existing functionality, deep links, role checks, personalization and data must remain intact.

## Review standard

Each lane records the actual states and interactions checked. A successful build does not count as visual verification. Screenshots use sample data and actual components. Test at 390px, 320px with enlarged text, and desktop; cover light, dark and a blue custom wallpaper where supported. Check keyboard order/focus, readable contrast, 44px touch controls, contained tables, no obscured primary controls, loading/empty/error/disabled states, and safe cancel paths.

## Route inventory and ownership

| Surface | Inventory | Owner | Current state |
| --- | --- | --- | --- |
| Reviewed member Home | Continue round, progress checklist, account rows, course conditions, history, rating | Sol stats / root | Live in PR95; deployment 43669165687 and both post-deploy checks passed |
| Reviewed Practice and My bag | Putting, fieldwork, disc inventory, forms, export and removal | Sol stats / root | Live in PR95; 320/390/1280 interactions verified |
| Remaining member app | All 21 MEMBER_DESTINATIONS, auth/profile/passkeys, help/install, nested forms and dialogs | Sol stats | Integrated; 21 routes × 3 viewports and representative nested flows passed |
| Admin | All 24 ADMIN_DESTINATIONS, event workspace, reports, moderation, nested forms and dialogs | Sol recovery | Integrated; 24 routes × 3 viewports and operator/finance/form workflows passed |
| Scorecard and round lifecycle | See scorecard matrix below | Sol watch | Bottom-control layout approved with compact name styling and imagery credit inside the map; integrated, with scoring, weather, offline service-worker and touch-layout regression checks passed. |
| Public Home | index.html; navigation, hero, memberships/dues/donate, course modal/carousel, feeds and footer | Sol stats / root | Integrated; public matrix and Home navigation/carousel/dialog actions passed |
| Events | events.html; hub, schedule, event/league details, live standings/chat, registrations, previous results, bag tags, campaigns and minutes | Sol stats / root | Integrated; public render and relevant nested interaction checks passed |
| Shop | pro-shop.html; search/filter, product, cart, checkout states and wallet/payment entry | Sol stats / root | Integrated; public render and relevant nested interaction checks passed |
| Public supporting pages | gvdg-blog.html, ryder-cup.html, scoring-app.html, tee-sign-preview.html | Sol stats / root | Integrated; public render and relevant nested interaction checks passed |
| Compatibility | archive.html redirects to the existing Events previous-results anchor | Root | Redirect target verified at 390 and 1280 px |
| Design references | design.html, design-field.html, design-night.html | Sol stats / root | Integrated; chooser, both directions and nested reference links verified at four sizes/themes |

## Scorecard matrix

- Setup, course/layout selection, saved layouts, start/join/guest and resume.
- Hole header, score keypad, player switching, full card, singles/doubles/match play.
- Rapid repeated input, score correction, existing undo/reset controls, focus and keyboard order.
- Pending/saved/syncing/error/locked/finalized states; airplane-mode start, reload, reconnect and exact retries.
- Map, deliberate marked lies, distance tools, explicit shots and penalties, mismatch guidance.
- Video capture/review/queue/upload/playback/publication and durable round/hole/player context.
- Read-only Watch Live, follow/hole persistence, reconnect/stale/final indicators, revocation.
- Sharing versus scoring invitations, settings, watch preview pairing, wrist layout, distance alerts.
- Finish/finalize, missing/conflicting scores, cancel paths and history/replay.

Root integration must verify the combined generated build and real service worker, not only source fixtures. Physical phone/watch sensors, browser camera permissions, battery behavior and store publication retain their separate evidence requirements in field-verification.md.

## Outstanding original roadmap work

Archive export/reimport and migration 0057 are integrated, with browser download/restore and Worker validation. Native phone source, pairing presentation and CI builds are integrated; physical validation, signing and store distribution remain separate. No broader UDisc parity claim is made from these software checks alone.

## Scorecard direction revision

The user rejected the first scorer visual pass because it looked more crowded and its previews omitted weather and wind speed. That iteration was held. The replacement visibly represents weather/wind, retains map and scoring access, and reduces competing panels. Backend/score-entry/offline correctness fixes remain in the integration draft.

The next previews were also rejected for oversized map controls and moving hole navigation to the top. The explicit requirement is now to retain bottom-anchored scoring and previous/next-hole navigation for one-handed use. Map overlays must be compact; occasional tee/pin adjustments can move into Tools while marked-lie actions remain readily accessible. No top-navigation scorecard concept is approved. The user subsequently approved the bottom-control layout and requested the image credit inside the map plus smaller given names over emphasized surnames on compact screens. These requested tweaks are authorized without another design approval.


## Shared Help and subsequent member cleanup

Help now uses the accessible shared dialog, restores focus, preserves a failed question/attachment and stays above the app docks. Five source entry points and 320 px enlarged text were checked. Public validation details are in `public-ui-validation.md`. The requested Home header removal, Account admin banner and Account typography cleanup shipped in PR #98 and remain in this release.


## Bag entry follow-up

The user requested searchable brand/model/plastic choices with custom options and voice input for adding discs. Implemented with editable suggestions, weight presets and custom values, reviewed voice transcripts, explicit Save, and typing fallback. Browser tests cover 320/390/1280 px, keyboard operation, permission and service failures, cancellation, and account changes. Real microphone recognition and provider availability are not established by mocked recognition tests.


## Installed app updates

Each deployed HTML document carries its own release marker. The update checker compares that loaded release with the published release on return to the app, reconnection and periodic checks. Later applies to the offered release only. Refresh waits for a pending worker to take control and checks that the page is reachable; it never reloads automatically. Entering an active scorecard cancels an in-progress requested refresh, and the prompt is deferred until scoring closes. Authentication, offline records and map storage are retained.

Already-open legacy windows need one reopen/reload after deployment to load this fix. The browser test uses real service-worker activation; actual app cache/offline behavior is covered separately by the built service-worker round test. Android notification sender branding remains controlled by the installed browser/app; the website already supplies club icon and badge assets.
