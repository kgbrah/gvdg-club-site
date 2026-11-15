# Scorecard layout preview

The earlier Map first and Scores first proposals were rejected. The revised preview keeps the live scorecard's score entry and hole navigation at the bottom for one-handed use.

Weather sits above the map with temperature, wind direction, wind speed, and gusts. Hole, C2, C1, Heat, and Tee sign sit above the image. Distance, Mark lie, and Undo sit below it. Mark tee and Mark pin are in Tools, alongside the full scorecard, shot details, scoring invitation, and tee order. Film, Watch link, Measure, and Tools stay within reach above the score tray.

The preview uses Farmville aerial imagery with sample hole geometry, scores, marked lies, heat, tee sign, and weather. The blue theme approximates the reference with a sample palette. On short or narrow screens, the map and score areas scroll independently while Previous and Next stay at the bottom. The landscape view places the two areas side by side.

## Open the interactive preview

From the repository root, run the fixture server and append `&layout=bottom&players=4&appearance=blue` to the printed local scorecard URL. Use `players=1` for a solo card or `appearance=light` for the standard light theme.

```sh
GVDG_SCORER_SERVE=1 GVDG_SCORER_PREVIEW_DATA=1 node scripts/qa/scorer-polish-browser-qa.mjs
```

Capture the review set with Chromium.

```sh
GVDG_SCORER_BOTTOM=1 GVDG_SCORER_SCREENSHOTS=/tmp/gvdg-scorer-bottom-dock \
  node scripts/qa/scorer-polish-browser-qa.mjs
```

The capture checks 390 × 844 solo and four-player screens, 320 × 720 at 125% text, landscape, and desktop. It checks the keypad using the shared focus fix in integration commit `9e22013`, plus a focused text dialog with a simulated smaller visual viewport. Physical mobile keyboard and safe-area behavior require device testing.
