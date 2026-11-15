# Public site visual and interaction checks

Run `node scripts/qa/public-polish-browser-qa.mjs` from the repository root. It serves the source entry points through Vite and uses fixture responses for club data. Set `GVDG_PUBLIC_IMAGES` to choose a screenshot folder. The default is `gvdg-public-polish` under the system temporary directory.

The render matrix covers 13 page and deep-link destinations in four Chromium profiles. The profiles are 390 px light, 320 px dark with a 20 px root font, and 1280 px in light and dark. Pages are checked for horizontal overflow and JavaScript exceptions. Screenshots use the bundled club fonts and scroll each visible reveal section into view. Browser interactions run at 390 px.

| Destination | Coverage |
| --- | --- |
| Home | Hero, scoring guide teaser, membership, Courses, upcoming events, area tournaments, club story and board, contact and footer. Membership appears above Courses. Both dues and login links are checked. The course carousel preserves all listings with an image fallback, collapsed additional courses, and keyboard access to the course dialog. Checked modal links and focus return, active slide alignment, mobile navigation, menu Escape and Donate link. The no-JavaScript page includes dues and application links. |
| Club events | Hub and event/league deep links. Fixture guest sign-up checks validation, division and CTP selection, then cancel and confirm withdrawal. Event details open 18 tee signs and maps in six-hole groups, including the final hole. Loading and error UI use the existing events status component. |
| Previous results archive | Redirect to the previous-results section of Events. Results continue to use the existing results feed and disclosure. |
| Pro Shop | Inventory, stock count, browse/search, sorting, the four secondary filters and reset. Checked loading, empty inventory, zero search matches and HTTP failure followed by retry. Cart jump and quantity changes, guest validation and mock PayPal handoff. Member store-credit submission is checked against a fixture, including the disabled empty-cart state and idempotency key. |
| Ryder Cup | Public board, scoring note, week and match link, team rosters on mobile and deep link to club league standings. Rendered with a small named team fixture. |
| Club Blog | Coming-soon page with working Events and Home links. |
| Scoring app guide | Customize, clips and Watch live remain prominent, with direct section links, score/install instructions, stat definitions, comparison and FAQ. Checked Watch live, metric and FAQ disclosure. The GVDG guide uses the current watch-link, clip privacy and shot-recording controls. |
| Tee-sign preview | Filled and incomplete samples remain visible. Checked theme toggle and fit at enlarged phone text. |
| Design chooser, Field and Night | Both directions and mobile layouts, chooser link and switch between directions. These remain reference pages with their own visual styles. |

The browser fixture uses simulated club writes and intercepts PayPal navigation. It covers the redirect checkout and store-credit UI; real payment capture and the PayPal SDK widget use their existing paths. External imagery, live feeds, maps, native installation and assistive-technology/device checks require their actual services or devices.
