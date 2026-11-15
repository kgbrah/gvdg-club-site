# Scorecard design previews

Both previews use the same sample round on Farmville aerial imagery. The sample tee, basket, scores, marked lies, heat, tee sign, and weather are fixtures. The weather strip shows 57°F, partly cloudy, wind from WNW at 8 mph, and gusts to 13 mph.

| Preview | What appears immediately after the hole and weather |
| --- | --- |
| Map first | A full-width map, followed by Film, Watch link, Measure, Tools, and scores. On desktop, the map and score entry sit alongside each other. |
| Scores first | Film, Watch link, Measure, Tools, and score entry, followed by a full-width map. Four-player cards reach the score controls earlier and scroll farther to reach the map. |

The layouts retain the wind compass, map focus, heat, tee sign, survey, mark and undo controls. Tee order has a disclosure. The value between − and + opens the keypad. Watch link opens the spectator sharing settings, while Invite to score remains in Round tools. Card sync shows when changes are pending or require attention.

## Review images

The capture command writes the following images to the chosen output directory. Phone references are 390 × 844. The 320 × 720 dark capture uses 125% text and includes the area below the fold. The desktop capture uses a custom wallpaper.

- `map-first-390-1p.png` and `map-first-390-4p.png`
- `score-first-390-1p.png` and `score-first-390-4p.png`
- The same four phone views with `-blue` in their filenames, using a sample custom palette
- `map-first-320-4p.png`
- `map-first-1280-4p.png`

## Open an interactive preview

From the repository root, run the fixture server and use the printed local URL.

```sh
GVDG_SCORER_SERVE=1 GVDG_SCORER_PREVIEW_DATA=1 node scripts/qa/scorer-polish-browser-qa.mjs
```

Append `&concept=map&players=4&appearance=blue` for the map-first preview. Use `concept=score` for scores first, `players=1` for a solo card, or `appearance=light` for the default light theme. The fixture feeds the scorer sample round data, and the map loads public aerial imagery.

Capture the review set with Chromium.

```sh
GVDG_SCORER_CONCEPTS=1 GVDG_SCORER_SCREENSHOTS=/tmp/gvdg-scorer-concepts \
  node scripts/qa/scorer-polish-browser-qa.mjs
```
