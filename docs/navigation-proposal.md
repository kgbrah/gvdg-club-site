# Navigation proposal for members and admins

Status: recommendation for review. The user requested recommendations without losing functionality. Do not replace the existing navigation until the proposed structure and a complete destination mapping have been reviewed.

## Problems to address

- Member pages expose both the public website navigation and a separate app tab bar. Home, Events, and More appear in competing contexts.
- Member More combines club destinations, the wallet, account security, profile editing, disc appearance, and an extensive theme builder in one long page.
- Admin Members, Courses, Layouts, Tee Signs, leagues, bag tags, campaigns, meeting minutes, and archives share an undifferentiated More destination.
- Event creation, imports, registration, and live scoring are separate destinations even when an admin is working on a single event.
- New users must learn where features are stored before they can complete common tasks.

## Recommended member structure

Use a compact app header with the club identity, Help, and an Account button. Keep the public website accessible through Club and Account. Use the same five primary destinations on phone and desktop:

| Destination | Contents and primary actions |
| --- | --- |
| Home | Continue an active round or start one; next event; recent activity; wallet and membership shortcuts |
| Play | Start, join, or watch a round; recent rounds and replay; course search; clear entry points to practice and equipment as those features ship |
| Events | Upcoming events, registration, my entries, league schedule and event results |
| Stats | Scoring and shot metrics, trends, ratings, format/date filters, imported history and data exports |
| Club | Directory, message board, bag tags and challenges, club standings, tee sign contributions, Pro Shop, club website |

Account is always reachable from the header: profile, wallet, membership, passkeys, appearance, disc style, installed-device help, notifications where supported, and logout. Appearance should open as its own page or panel rather than occupying most of the Club menu.

Keep one primary action on each screen. An active round takes priority on Home. A first-use checklist may offer profile setup, starting a practice/casual round, and installing the app; it must be dismissible and must not block guest scoring.

## Recommended admin structure

Use an explicit Admin header and a visible switch back to the member app. Provide a labeled Find a tool search on phone and desktop. Keep the same groups across device sizes:

| Destination | Contents |
| --- | --- |
| Today | Existing Needs you queue, current event, check-in desk, orders awaiting handoff, common shortcuts |
| Events | Event list and creation, event import, league seasons, and an event workspace with Registration, Check-in, Live scoring, and Results |
| Members | Existing member administration, applications, member details, and membership status |
| Money | Existing shop inventory, orders and wallets; campaigns; payment context links from member and event records |
| Tools | Courses, layouts, tee signs, bag tags, meeting minutes, data archive, help and account controls |

During an active event, keep a clear Live scoring shortcut on Today and in its event workspace. Do not bury the current-event task in a generic tools list. Course tools should retain a selected course while moving between layouts, signs and review tasks.

Use plain labels: Import event instead of Import, Meeting minutes instead of Minutes, Member applications instead of an unexplained count. Badge counts should correspond to actionable work; selecting a badge should open the relevant filtered queue.

## Existing admin destinations remain reachable

| Current tab key | Proposed location |
| --- | --- |
| today | Today |
| events | Events / Event list |
| create | Events / New event |
| import | Events / Import event |
| registration | Events / Selected event / Registration |
| scoring | Events / Selected event / Live scoring, plus Today shortcut |
| shop | Money / Inventory |
| orders | Money / Orders |
| wallets | Money / Wallets |
| members | Members |
| courses | Tools / Courses |
| layouts | Tools / Courses / Layouts |
| tee-signs | Tools / Courses / Tee signs |
| leagues-mgmt | Events / League seasons |
| bag-tags | Tools / Bag tags, with Today actions for requests |
| fundraisers | Money / Campaigns |
| meetings | Tools / Meeting minutes |
| data-archive | Tools / Data archive |
| more | Tools, with compatible old entry behavior |

Existing member tab keys overview, play, events, season, more, board, tee and club must retain compatible navigation. Season becomes the Stats label; board, tee and directory remain explicit Club destinations. Profile, passkey, wallet, theme, disc color, public site, shop, Help, admin access and logout actions all remain available.

## In-round navigation

Keep the hole, score controls, current player and save/sync state visible. Offer a labeled Round tools sheet for the full scorecard, map, filming, watch pairing, sharing, and round settings. Preserve fast access to marked lies and video, and keep finalization clearly separate from navigation. Back navigation must not abandon unsaved or pending work. Labels and capability states should explain whether a feature is available offline.

## Implementation and verification gates

1. Build a destination registry that preserves every existing route key, handler, permission and data operation; navigation is a new presentation of those destinations.
2. Preserve old links, notification destinations and selected event/course context. Browser Back should return through app navigation predictably.
3. Show only authorized destinations, and retain server authorization regardless of menu visibility.
4. Add role-aware tool search and common-task synonyms without exposing private records in suggestions.
5. Verify each existing destination and action from both phone and desktop layouts. Test current deep links, notifications, keyboard navigation, screen-reader labels, large text and custom themes.
6. Verify new-member tasks (start/join/watch, register, view stats, replay video, find wallet) and new-admin tasks (approve application, create/import event, check in players, start scoring, fulfill order, edit layout, review sign).
7. Compare task completion and navigation errors before and after. Do not equate a smaller menu with a better experience if important actions become harder to find.

Implementation should begin with navigation and context handling, then progressive onboarding. Keep event/scoring workflows and stored data unchanged unless a separately reviewed feature explicitly requires a change.
