# Whole-app polish coverage

The user approved the revised Member Home direction and explicitly requested every page, button and section, with the scorecard receiving the deepest appearance and behavior review. Approval includes implementation and GitHub deployment. Existing functionality, deep links, role checks, personalization and data must remain intact.

## Review standard

Each lane records the actual states and interactions checked. A successful build does not count as visual verification. Screenshots use sample data and actual components. Test at 390px, 320px with enlarged text, and desktop; cover light, dark and a blue custom wallpaper where supported. Check keyboard order/focus, readable contrast, 44px touch controls, contained tables, no obscured primary controls, loading/empty/error/disabled states, and safe cancel paths.

## Route inventory and ownership

| Surface | Inventory | Owner | Current state |
| --- | --- | --- | --- |
| Reviewed member Home | Continue round, progress checklist, account rows, course conditions, history, rating | Sol stats / root | Live in PR95; deployment 43669165687 and both post-deploy checks passed |
| Reviewed Practice and My bag | Putting, fieldwork, disc inventory, forms, export and removal | Sol stats / root | Live in PR95; 320/390/1280 interactions verified |
| Remaining member app | All 21 MEMBER_DESTINATIONS, auth/profile/passkeys, help/install, nested forms and dialogs | Sol stats | Integrated;21routes×3viewports and representative nested flows passed |
| Admin | All 24 ADMIN_DESTINATIONS, event workspace, reports, moderation, nested forms and dialogs | Sol recovery | Integrated;24routes×3viewports and operator/finance/form workflows passed |
| Scorecard and round lifecycle | See scorecard matrix below | Sol watch | Highest-priority active lane |
| Public Home | index.html; navigation, hero, memberships/dues/donate, course modal/carousel, feeds and footer | Sol stats / root | Inventory complete; visual pass pending |
| Events | events.html; hub, schedule, event/league details, live standings/chat, registrations, previous results, bag tags, campaigns and minutes | Sol stats / root | Pending |
| Shop | pro-shop.html; search/filter, product, cart, checkout states and wallet/payment entry | Sol stats / root | Pending |
| Public supporting pages | gvdg-blog.html, ryder-cup.html, scoring-app.html, tee-sign-preview.html | Sol stats / root | Pending |
| Compatibility | archive.html redirects to the existing Events previous-results anchor | Root | Redirect target verified at390 and1280 |
| Design references | design.html, design-field.html, design-night.html | Sol stats / root | Chooser and both reference layouts pass390/1280 smoke; nested links queued for public lane |

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

Archive export/reimport resumed in archive worktree (0057 reserved). Native phone source and CI builds are complete (PR94), but pairing presentation awaits polished member/scorer placement; physical validation and signing remain separate. No broader UDisc parity claim is made from these software checks alone.
