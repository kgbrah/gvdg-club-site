# Whole-app polish coverage

The user approved the revised Member Home direction and explicitly requested every page, button and section, with the scorecard receiving the deepest appearance and behavior review. Approval includes implementation and GitHub deployment, except the subsequently rejected scorecard direction, which requires fresh visual approval. Existing functionality, deep links, role checks, personalization and data must remain intact.

## Review standard

Each lane records the actual states and interactions checked. A successful build does not count as visual verification. Screenshots use sample data and actual components. Test at 390px, 320px with enlarged text, and desktop; cover light, dark and a blue custom wallpaper where supported. Check keyboard order/focus, readable contrast, 44px touch controls, contained tables, no obscured primary controls, loading/empty/error/disabled states, and safe cancel paths.

## Route inventory and ownership

| Surface | Inventory | Owner | Current state |
| --- | --- | --- | --- |
| Reviewed member Home | Continue round, progress checklist, account rows, course conditions, history, rating | Sol stats / root | Live in PR95; deployment 43669165687 and both post-deploy checks passed |
| Reviewed Practice and My bag | Putting, fieldwork, disc inventory, forms, export and removal | Sol stats / root | Live in PR95; 320/390/1280 interactions verified |
| Remaining member app | All 21 MEMBER_DESTINATIONS, auth/profile/passkeys, help/install, nested forms and dialogs | Sol stats | Integrated;21routes×3viewports and representative nested flows passed |
| Admin | All 24 ADMIN_DESTINATIONS, event workspace, reports, moderation, nested forms and dialogs | Sol recovery | Integrated;24routes×3viewports and operator/finance/form workflows passed |
| Scorecard and round lifecycle | See scorecard matrix below | Sol watch | Visual direction rejected; new mockups required; hold deployment. Correctness fixes retained. |
| Public Home | index.html; navigation, hero, memberships/dues/donate, course modal/carousel, feeds and footer | Sol stats / root | Integrated; public matrix and Home navigation/carousel/dialog actions passed |
| Events | events.html; hub, schedule, event/league details, live standings/chat, registrations, previous results, bag tags, campaigns and minutes | Sol stats / root | Integrated; public render and relevant nested interaction checks passed |
| Shop | pro-shop.html; search/filter, product, cart, checkout states and wallet/payment entry | Sol stats / root | Integrated; public render and relevant nested interaction checks passed |
| Public supporting pages | gvdg-blog.html, ryder-cup.html, scoring-app.html, tee-sign-preview.html | Sol stats / root | Integrated; public render and relevant nested interaction checks passed |
| Compatibility | archive.html redirects to the existing Events previous-results anchor | Root | Redirect target verified at390 and1280 |
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

Archive export/reimport and migration0057 are integrated, with browser download/restore and Worker validation. Native phone source, pairing presentation and CI builds are integrated; physical validation, signing and store distribution remain separate. No broader UDisc parity claim is made from these software checks alone.

## Scorecard direction revision

The user rejected the first scorer visual pass because it looked more crowded and its previews omitted weather and wind speed. The scorecard visual rollout is held. New source mockups must visibly represent weather/wind, retain map and scoring access, reduce competing panels, and receive fresh user approval before deployment. Backend/score-entry/offline correctness fixes remain in the integration draft.

The next previews were also rejected for oversized map controls and moving hole navigation to the top. The explicit requirement is now to retain bottom-anchored scoring and previous/next-hole navigation for one-handed use. Map overlays must be compact; occasional tee/pin adjustments can move into Tools while marked-lie actions remain readily accessible. No top-navigation scorecard concept is approved.


## Shared Help and subsequent member cleanup

Help now uses the accessible shared dialog, restores focus, preserves a failed question/attachment and stays above the app docks. Five source entry points and320px enlarged text were checked. Public validation details are in `public-ui-validation.md`. The requested Home header removal, Account admin banner and Account typography cleanup are tracked as a focused live update; they do not authorize the rejected scorecard design.
