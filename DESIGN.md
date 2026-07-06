# Greenville Disc Golf Club Design System

## 1. Atmosphere & Identity

Greenville Disc Golf Club should feel local, energetic, outdoors-focused, and easy to scan on a phone before or after a round. The signature is a high-contrast orange and blue sport palette over light/dark surfaces with forest imagery, condensed display headings, and compact event cards.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Accent/primary | `--primary` | `#FF6B35` | `#FF6B35` | CTAs, links, active states, date badges |
| Accent/secondary | `--secondary` | `#004E89` | `#004E89` | Gradients, supporting actions |
| Accent/warm | `--accent` | `#F7B801` | `#F7B801` | Price and highlight details |
| Accent/green | `--green` | `#2D5016` | `#2D5016` | Club/nature gradient accents |
| Score/conflict | `--over` | `#C8472E` | `#FF7A5C` | Over-par labels, scoring conflicts, blocking error states |
| Score/conflict soft | `--over-soft` | `rgba(200, 71, 46, 0.10)` | `rgba(255, 122, 92, 0.16)` | Conflict row and cell backgrounds |
| Surface/primary | `--bg-primary` | `#F4F4F9` | `#0F0F1E` | Page background, nested card surfaces |
| Surface/secondary | `--bg-secondary` | `#FFFFFF` | `#1A1A2E` | Main section panels and modals |
| Surface/tertiary | `--bg-tertiary` | `#F4F4F9` | `#252538` | Metadata strips and inset panels |
| Text/primary | `--text-primary` | `#1A1A2E` | `#F4F4F9` | Headings and primary labels |
| Text/secondary | `--text-secondary` | `#333333` | `#E0E0E0` | Body copy |
| Text/tertiary | `--text-tertiary` | `#555555` | `#C0C0C0` | Supporting metadata |
| Text/muted | `--text-muted` | `#666666` | `#A0A0A0` | Captions, empty states |
| Border/default | `--border-color` | `#E2E2EA` | `#2A2A3E` | Cards, dividers, outlines |
| Shadow/default | `--card-shadow` | `rgba(0, 0, 0, 0.1)` | `rgba(0, 0, 0, 0.3)` | Section and card elevation |
| Shadow/hover | `--card-shadow-hover` | `rgba(0, 0, 0, 0.15)` | `rgba(0, 0, 0, 0.5)` | Hover elevation |

### Rules

- Prefer existing CSS variables over raw colors.
- New semantic colors must be added here before use.
- Gradients combine `--primary`, `--secondary`, and `--green` only when the element is a major CTA, badge, or sport-themed feature.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Hero display | `clamp(2.5rem, 8vw, 5rem)` | 400 | 1.1 | `0.05em` | Hero title |
| Section display | `clamp(2rem, 6vw, 3.5rem)` | 400 | 1.1-1.2 | `0.05em` | Section titles |
| Slide title | `clamp(1.8rem, 4vw, 2.8rem)` | 400 | 1.2 | `0.03em` | Carousel and panel headings |
| Card title | `1.2rem-1.6rem` | 400 | 1.2-1.3 | `0.02em-0.03em` | Event, course, and contact cards |
| Body | `1rem` | 400 | 1.6 | `0` | Default copy |
| Body/sm | `0.85rem-0.95rem` | 400-600 | 1.4-1.5 | `0` | Metadata and subtitles |
| Caption | `0.65rem-0.8rem` | 600-700 | 1.2-1.4 | `0.03em-0.05em` | Badges and date labels |

### Font Stack

- Display: `Bebas Neue, sans-serif`
- Body: `Archivo, system-ui, -apple-system, sans-serif`

### Rules

- Use `Bebas Neue` for headlines, date numbers, and compact card labels.
- Body text stays in `Archivo`.
- Avoid negative letter spacing; the current system uses neutral or positive tracking.

## 4. Spacing & Layout

### Base Unit

Spacing follows a 4px base through rem values.

| Token | Value | Usage |
|-------|-------|-------|
| Tight | `0.25rem-0.5rem` | Inline metadata, icon-to-text gaps |
| Compact | `0.75rem-1rem` | Small controls and card internals |
| Standard | `1.25rem-1.5rem` | Event/card padding |
| Comfortable | `2rem` | Section internals and modals |
| Section | `clamp(2rem, 6vw, 4rem)` | Major content sections |
| Page max | `1200px` | Main content width |

### Grid

- Mobile: single-column stacks.
- Tablet/Desktop: responsive grids with `minmax(250px, 1fr)` or `minmax(300px, 1fr)`.
- Main sections are constrained to about `1200px` and centered.

### Rules

- Keep cards and controls stable across hover states; transforms must not alter layout flow.
- On mobile, preserve single-column event and tournament lists with no horizontal scrolling.

## 5. Components

### Event Item

- Structure: date badge, text content, optional link wrapper.
- Variants: linked, TBD, hidden-extra.
- Spacing: `1.5rem` gap and padding on desktop, tighter on mobile.
- States: hover translates slightly and changes surface/elevation; linked cards use `has-link`.
- Accessibility: linked events are real anchors with safe external URLs.
- Motion: transform and opacity only.

### Tournament Item

- Structure: date badge, event metadata, arrow icon.
- Variants: hidden-mobile, expanded.
- Spacing: `0.75rem-1.25rem` padding depending on viewport.
- States: hover translates on desktop; toggle expands hidden mobile rows.
- Accessibility: external links include `rel="noopener"`.
- Motion: transform and opacity only.

### Toggle Button

- Structure: text span plus chevron icon.
- Variants: collapsed, expanded.
- Spacing: `0.75rem 1.5rem`.
- States: hover fills with `--primary`; expanded rotates icon.

### Member Dashboard Shell

- Structure: React-owned auth gate, bundled auth/session controller, title, tablist, welcome/logout banner, admin portal link, overview, account tools, event registration, board, tee-sign capture, and club panels mounted into stable HTML wrappers.
- Variants: login, forced-PIN, profile setup, overview, events, board, tee signs, and club tabs; auth/account tools dispatch credential, passkey, profile, and logout events while bundled member auth modules perform the secure flows.
- Spacing: dashboard wrappers keep the existing `my-dashboard`, `club-register`, `club-board`, and `tee-capture` surfaces so migrated panels retain the same mobile rhythm; the welcome banner uses the established green banner primitive and stays compact on phones.
- States: migrated legacy fallback nodes must be absent, not hidden; auth mode is driven by `gvdg:member-auth-mode`; the bundled auth controller owns `gvdg:member-auth-ready`, `gvdg:member-profile-updated`, and login/session events; static panel wrappers stay visible by default under the auth-gated content, and the bundled dashboard router owns `gvdg:select-dashboard-tab`, `gvdg:member-dashboard-opened`, and wrapper `dtab-off` state; individual panels do not imperatively reveal their parent wrappers; the admin portal link renders only on the overview tab for admin members.
- Accessibility: React tabs expose `role="tab"` and `aria-selected`; auth, profile, logout, and account actions are real buttons/forms with preserved labels.
- Motion: tab changes are immediate and should not resize fixed controls or introduce horizontal overflow.

### Member Dashboard Dialogs

- Structure: React-owned document-level modal renderer for member dashboard alerts and confirmations; separate dashboard roots call a shared dialog service instead of native browser dialogs.
- Variants: neutral alerts, destructive confirmations, cancel action, confirm action, Escape dismissal, and backdrop dismissal.
- Spacing: centered modal uses `--bg-secondary`, `--border-color`, `--shadow`, compact actions, and full-width stacked actions on narrow phones.
- States: one dialog is shown at a time; queued requests resolve in order; destructive confirmations use the primary-strong CTA treatment.
- Accessibility: dialogs expose `role="dialog"`, `aria-modal`, labelled title/body, and real action buttons.
- Motion: static modal; no layout animation.

### Dashboard Rating Panel

- Structure: panel header with category label/count and a prominent live rating, followed by compact per-round rows.
- Variants: competitive and casual; both use the same primitive so histories stay visually separate but comparable.
- Spacing: `0.75rem-1rem` panel padding, `0.6rem` row gaps, single column on mobile and two columns on tablet/desktop.
- States: empty state text inside each panel; rows remain stable with or without UDisc export actions.
- Accessibility: each panel is labelled by its category heading.
- Motion: static display; no layout-shifting animation.

### Member Directory Panel

- Structure: stat cards, membership growth chart, search/filter controls, paginated member card grid, and count status.
- Variants: all members, founding members, PDGA members, empty search results, and load-more state.
- Spacing: reuses dashboard card spacing with a single-column mobile grid and responsive multi-column desktop cards.
- States: filter buttons expose pressed state; count text updates through a polite status region.
- Accessibility: member search has an explicit label, external PDGA links use safe new-tab behavior, and chart bars expose per-year labels.
- Motion: static except existing card hover transforms.

### Meeting Minutes Accordion

- Structure: dated minutes list with badge, expandable section groups, action-item callout, and download link.
- Variants: expanded, collapsed, empty, and new-badge minutes.
- Spacing: compact `meeting-minutes-*` primitives keep long minutes readable inside the dashboard surface.
- States: accordion headers use real buttons with `aria-expanded`.
- Accessibility: section titles remain text, the download action is a real link, and iconography is decorative.
- Motion: only the chevron rotation communicates expand/collapse state.

### Doubles League Panel

- Structure: quick stats, tabbed records views, champions grid, searchable/sortable all-time leaderboard, season-results table, and player-detail modal.
- Variants: champions, all-time leaders, season results, filtered player search, paged leaderboard, and selected-player modal.
- Spacing: reuses `doubles-*` dashboard primitives with dense tables, scroll-safe wrappers, and responsive champion cards.
- States: tab buttons expose selected state, sortable headers use button controls, load-more updates the visible row count, and player rows open modal details.
- Accessibility: tabs use tab roles, table sort state is exposed through `aria-sort`, modal close has an explicit label, and search has an accessible label.
- Motion: static data display; the modal and existing hover treatments must not shift surrounding layout.

### Score App Shell

- Structure: sticky topbar with fixed square logo, truncating title/subtitle, members shortcut, leaderboard control, and theme toggle.
- Variants: home/setup state hides leaderboard; live card state shows leaderboard and replaces the subtitle with course/layout context. Live casual rounds also use a compact `Share / Add / Manage` tools row below the topbar.
- Spacing: compact mobile-first controls at `38px-40px`, with gaps from the tight/compact spacing scale.
- States: React owns title, subtitle, leaderboard visibility/click handling, and theme toggling; icon buttons use stable dimensions and active transform only; hidden controls must not reserve layout space.
- Accessibility: action controls expose text labels through `aria-label`, `title`, or visually hidden text; icons are decorative.
- Motion: static except for the existing active press scale.

### Score Setup Flow

- Structure: stacked cards for home, course pick, layout pick, and casual round setup, rendered as React components inside the existing score app shell; the legacy score controller only dispatches setup view state and callbacks.
- Variants: empty course/layout states, selected setup options, and back navigation.
- Spacing: reuses `.card`, `.stack`, `.tap-row`, `.setup-grid`, and `.setup-option` primitives from the score app.
- States: setup options use `aria-pressed` and tokenized borders/backgrounds for selected state; legacy setup fallback nodes must be absent, not hidden.
- Accessibility: course/layout rows and setup options are real buttons; join-code entry submits on Enter.
- Motion: no decorative animation; navigation is immediate and preserves the existing active press feedback.

### Score Auth Flow

- Structure: React-owned login and forced-PIN cards mounted in the score app shell; the legacy score controller supplies auth, passkey, guest, and set-PIN callbacks only.
- Variants: member login, passkey-supported login, guest-token continuation, forced PIN change, pending submit states, and inline errors.
- Spacing: reuses `.card`, `.stack`, `.field`, `.lbl`, `.btn`, `.muted`, and `.return-members`; auth errors use the score conflict color token.
- States: submit buttons disable while pending; validation errors render in a polite inline error row; successful auth leaves the auth renderer through the normal boot path.
- Accessibility: login and PIN inputs are labelled, forms submit on Enter, errors use alert semantics, and passkey support uses a Lucide icon with text.
- Motion: static card flow; only existing button active states apply.

### Score Leaderboard Sheet

- Structure: React-owned bottom sheet overlay with grab handle, leaderboard table, optional UDisc export disclosure, finalize status panel, and close action; the legacy score controller supplies standings, blockers, export data, and callbacks only.
- Variants: empty leaderboard, singles/player rows, doubles/pair rows, stroke to-par result, matchplay status result, final round, ready-to-finalize, blocked finalize, and casual round finish action.
- Spacing: reuses `.overlay`, `.sheet`, `.lb`, `.btn`, and finalize sheet primitives from the score app; finalization details use compact rows and stay within the sheet scroll area.
- States: overlay backdrop click and close button dismiss the sheet; live snapshots re-render the React sheet when open; finish button is disabled until the card has no conflicts or missing confirmations.
- Accessibility: close and finish actions are real buttons; table headers label rank/player/thru/result columns; the shared UDisc export disclosure is React-owned and uses a real outbound link.
- Motion: bottom sheet remains static; only existing button active states apply.

### Score Manage Players Sheet

- Structure: React-owned bottom sheet overlay with grab handle, player rows, optional doubles pair editor, and close action; the legacy score controller supplies players, scoring mode, and save/remove callbacks only.
- Variants: singles remove list, doubles pair labels, current-player leave action, other-player remove action, and live re-render when cardmates change while the sheet is open.
- Spacing: reuses `.overlay`, `.sheet`, `.card`, `.stack`, `.prow`, `.btn`, and `.field` primitives; pair inputs are compact grid labels inside an inset card.
- States: overlay backdrop click and close button dismiss the sheet; saving pairs closes only after the server accepts; remove/leave prompts confirm before closing and posting.
- Accessibility: pair fields use real labels, remove/leave/close/save are real buttons, and no icon-only actions appear in this management sheet.
- Motion: static bottom sheet; button active states use the existing score app press feedback.

### Score Dialogs

- Structure: React-owned document-level modal renderer for score prompts and confirmations; the legacy score controller supplies dialog copy and awaits resolved values only.
- Variants: add-player prompt, doubles pair-label prompt, finish-round confirmation, and remove/leave danger confirmation.
- Spacing: reuses `.overlay`, `.sheet`, `.field`, `.lbl`, `.btn`, `.muted`, and compact modal actions; dialogs center in the viewport and stay within safe-area padding.
- States: overlay click, Escape, and cancel resolve without side effects; required prompt fields show inline errors; danger confirmations use the score conflict token.
- Accessibility: dialogs expose `role="dialog"`, `aria-modal`, labelled title/body, autofocus prompt inputs, and real submit/cancel buttons.
- Motion: static modal; only existing button active states apply.

### Scorecard View

- Structure: React-owned live hole screen with Round Weather, casual-round tools, hole navigation, optional tee-sign card, scorecard selector, player/pair steppers, totals bar, and hole jump grid; the legacy score controller supplies derived rows and callbacks only.
- Variants: event card, casual round with share/add/manage tools, singles rows, doubles pair rows, matchplay status, dormie badge, tee-sign highlight, score conflicts, score-target warning, completed holes, and current-hole states.
- Spacing: reuses `.weather-strip`, `.round-tools`, `.hole-head`, `.tee-sign-card`, `.scorecard-owner`, `.prow`, `.stepper`, `.totbar`, and `.holegrid` primitives so the migrated view keeps the existing mobile rhythm.
- States: scorer changes, hole navigation, jump-grid taps, plus/minus steppers, and weather refreshes rerender through React; compass updates use the shared weather subscription helpers.
- Accessibility: navigation and score steppers expose action labels, scorer selection has a label, tool buttons pair Lucide icons with text, and hole jump buttons expose hole labels.
- Motion: static layout; only existing active press feedback and weather wind-arrow rotation apply.

### Score Status View

- Structure: React-owned loading state and blocking message card mounted in the score app shell; the legacy score controller supplies retry and leaderboard callbacks only.
- Variants: spinner, retryable error, informational blocker, and leaderboard shortcut.
- Spacing: reuses `.center`, `.spin`, `.card`, `.stack`, `.section`, `.muted`, and `.btn` primitives.
- States: retry buttons call the normal boot path; leaderboard shortcut opens the React-owned leaderboard sheet.
- Accessibility: loading uses a status role, message actions are real buttons, and Lucide icons are decorative.
- Motion: spinner uses the existing rotation animation; no other motion is added.

### Score Notifications

- Structure: React-owned document-level notification mount for transient toasts, scoring-conflict alerts, offline-sync rejection alerts, and the offline bar; the legacy score controller supplies notification messages and online state only.
- Variants: default bottom toast, top conflict alert, rejected offline-score alert, and persistent offline bar.
- Spacing: reuses `.toast`, `.toast.conflict`, and `.offline-bar`; icon-to-text gaps use the tight spacing scale.
- States: toasts fade out on timers and dismiss on tap; conflict alerts stay longer, stack below the offline bar when needed, and use the score conflict token; offline state persists until connectivity returns.
- Accessibility: transient notices use status or alert roles according to severity, and icons are decorative Lucide symbols rather than emoji.
- Motion: opacity fade only; no layout animation.

### Round Weather

- Structure: compact header, primary temperature/condition group, condition graphic, wind action, secondary meta pills, and course-location note.
- Variants: pending/unavailable states use a single empty message; live weather promotes condition, feels-like temperature, a graphic condition cue, and wind while keeping humidity, precipitation, and changes secondary.
- Spacing: condition and graphic share the first row on narrow phones with wind below; condition, graphic, and wind form a compact three-part row above `420px`.
- States: the score app renders Round Weather through React using shared summary and compass helpers; the standalone DOM renderer remains available for non-score surfaces. Wind starts `North-up`, moves through `Listening...`, and changes to `Phone-relative` when device orientation produces a heading.
- Accessibility: wind is a real button with an arrow title/label that explains whether the arrow is north-up or phone-relative; the condition graphic is a labeled image cue and does not replace the text condition.
- Motion: only the wind arrow rotates, using a short transform transition.

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | `0.2s` | ease | Toggle hover and small state changes |
| Standard | `0.3s` | ease | Card hover, menu, carousel controls |
| Reveal | `0.6s` | ease | Section and fade-in entrances |

### Rules

- Animate `transform`, `opacity`, and color changes.
- Existing carousel, reveal, and hover behavior should be preserved.
- Do not remove loading, empty, or error feed states to simplify scripts.

## 7. Depth & Surface

### Strategy

Depth is mixed: soft shadows for elevated cards/sections, borders for cards and controls, and tonal shifts for dark mode.

| Level | Value | Usage |
|-------|-------|-------|
| Border | `1px-2px solid var(--border-color)` | Cards, controls, modals |
| Section shadow | `0 10px 40px var(--card-shadow)` | Main section panels |
| Hover shadow | `0 10px 30px var(--card-shadow-hover)` | Interactive cards |
| Modal shadow | `0 20px 60px rgba(0, 0, 0, 0.3)` | Modal overlays |

### Rules

- Use borders and shadows together only where the existing pattern already does.
- Dark mode relies more on tonal surfaces and lower-contrast borders.
