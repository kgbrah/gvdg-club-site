# GVDG Events Live Order And Scoring Manual QA

verdict: PASS

## Fresh Capture Set

Generated after the latest test cleanup and mobile overlay fixes with:

```bash
node /tmp/gvdg-live-now-visual-qa.mjs
```

Durable copies:

- `.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-events-hub-1280.png`
- `.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-events-detail-1280.png`
- `.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-events-detail-768.png`
- `.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-events-detail-375.png`
- `.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-member-dashboard-1280.png`
- `.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-member-dashboard-768.png`
- `.omo/evidence/gvdg-events-live-order-scoring/gvdg-live-now-member-dashboard-375.png`

## Matrix

| Surface | Viewport | Result | Evidence |
|---|---:|---|---|
| Events hub | 1280 | Live Now renders above the normal Events feed, and the live card shows play/scoring format. | `gvdg-live-now-events-hub-1280.png` |
| Event detail | 1280 | Detail summary shows doubles/matchplay format, 4 players, 2 teams, Team heading, Blue/Red rows, and teammate names. | `gvdg-live-now-events-detail-1280.png` |
| Event detail | 768 | Tablet layout keeps the same scoring/team information without horizontal overflow or assistant overlay. | `gvdg-live-now-events-detail-768.png` |
| Event detail | 375 | Mobile layout keeps the closed nav off-screen and preserves readable team rows without assistant overlay. | `gvdg-live-now-events-detail-375.png` |
| Member dashboard | 1280 | Overview shows `Live Now & Scorecards`, public Live Now card, and View event action before personal scorecards. | `gvdg-live-now-member-dashboard-1280.png` |
| Member dashboard | 768 | Tablet dashboard keeps the public live card and personal scorecard section readable without assistant overlay. | `gvdg-live-now-member-dashboard-768.png` |
| Member dashboard | 375 | Mobile dashboard has no horizontal overflow, no header overlay, and preserves the live event action. | `gvdg-live-now-member-dashboard-375.png` |

## Script Assertions

The Playwright visual QA script passed these assertions:

- Events Live Now top slot is above the calendar feed.
- Event detail has doubles/matchplay summary, Team heading, and Blue row.
- Member dashboard has the Live Now & Scorecards public Live Now card.
- No horizontal overflow at 1280, 768, or 375 viewport widths.

## Manual Overlay Checks

- Confirmed the 375px event detail capture no longer has the Crotts avatar overlapping the Teams summary card.
- Confirmed the 768px event detail capture no longer has the Crotts avatar overlapping the Date summary card.
- Confirmed the 375px member dashboard capture no longer has the closed header/nav overlaying the Store Credit wallet panel.

## Browser Regression Tests

- `tests/events.ui.test.mjs` drives the public Events page and member dashboard through real DOM.
- `tests/events.ui.test.mjs` also drives the mobile casual scorecard setup and verifies the real `/rounds` request separates scoring format from play format.
