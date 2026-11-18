# GVDG rating validation

Predictive accuracy is unknown. No independent sample of verified historical shot totals, as-played layout revisions, and ratings observed before play was available for this release. The automated tests establish chronological isolation and minimum sample handling using synthetic data.

The harness predicts held-out stroke totals. It freezes the calibration set at a supplied date and builds each baseline using prior competition scores on the exact layout revision. A calibration field must have been played and its results available before the cutoff. Its anchors must have been observed and effective before the field played. Holdout predictions use only the anchors available at the cutoff. Held-out scores contribute only to error measurements.

Run the report with an authorized, locally prepared JSON export. The harness prints aggregate counts and errors. Use opaque member IDs in the input and keep the source file outside the repository.

```sh
GVDG_RATING_VALIDATION_INPUT=/path/to/rating-validation-input.json \
  npm test --prefix auth-worker -- test/rating-validation-report.test.ts
```

The JSON object has `cutoff`, `anchors`, `calibrationFields`, and `heldOutRounds` fields. Use ISO timestamps and the stored `geometry-v1:` layout revision. Anchors need `memberId`, `rating`, `observedAt`, and `effectiveAt`. Each calibration field needs `eventId`, `layoutRevision`, `playedAt`, `availableAt`, and a `results` array of member ID and total strokes. Each held-out round needs `memberId`, `layoutRevision`, `playedAt`, and `total`. The input should contain completed singles stroke rounds only.

Error measures are withheld until at least 30 eligible rounds, 10 distinct players, and two layout revisions are represented. The output includes mean absolute error, signed bias in strokes, and the error from predicting the training field's simple mean score. These minimums prevent tiny samples from being shown as evidence of performance. They do not establish statistical significance for a measured sample.

An edited result or scoring configuration changes the event's source revision. The club withholds affected competition estimates and excludes them from overall estimates and prior anchors until repair verifies the field again. Casual estimates also require a current result and calibration still supported by the source event and the anchors available when that event was played. Wider historical effects can propagate across later rounds during the scheduled repair sweeps. Archived numeric ratings remain visible as historical values.

## PDGA layout baselines

Club rounds on a layout that matches a PDGA tournament layout can be rated from PDGA's own SSAs. Which PDGA rounds count:

- Only matched rounds from an earlier calendar day (US Eastern) than the round being rated, so there is no look-ahead. When PDGA does not publish a round's day (`ShowDate` false on multi-day events), the event's last day is used.
- Only the 6 most recent such rounds from the 3 years before the round being rated (ties on a day break by event, round and layout ID).
- Only rounds whose holes still fit the layout as played:
  - the same hole count, with par equal on at least 90% of holes;
  - for automatic matches, each hole within max(25 ft, 8%) on at least 80% of holes, and the compared total within 5%.

An admin-confirmed match may differ in hole lengths, never in hole count or par. Our lengths are straight tee-to-basket lines, while PDGA's often follow the fairway, so doglegs make ours shorter.

The baseline is the median of those rounds' SSAs after each is normalised to no wind: the round's own `weatherSsaAdjustment(gust)` is subtracted. A rating then adds the rated round's own gust adjustment, as the club layout baseline already does. How each kind of round uses it (`rating_method = 'pdga'`):

- Casual rounds use the PDGA baseline before an earlier club field.
- Small competition fields use it: a provisional two-player solve, or no solve at all (fewer than two rated players).
- Fields with a stable solve of their own (three or more rated players) keep their day-of SSA, with the PDGA baseline stored beside it in `round_ratings.pdga_baseline_ssa` for comparison.

Wind for each matched PDGA round comes from Open-Meteo's historical archive (`archive-api.open-meteo.com/v1/archive`, no key) at the matched course's latitude and longitude. It uses the same measure and unit the club's live weather feeds the engine: `wind_gusts_10m` in mph. PDGA does not publish when a round was played, so we take the **maximum hourly gust from 09:00 to 17:00 America/New_York** on the round's day. That is an assumption about the hours of play: a morning round on a day that turned windy in the afternoon is treated as windy.

- The hourly cron fetches a few course-days per tick (one request covers every round at that course that day), backing off on failure.
- A recent day with no archive data yet is retried daily. After 14 days, or six failures, the round is marked unavailable.
- A round without wind is used as played, and the provenance says so, e.g. "Median of the 6 most recent PDGA rounds (2025–2026), no-wind SSA 49.6; 1 round has no wind data and is used as played".
- Wind measured at a course the layout is no longer matched to is ignored and fetched again.

The SSA taken from each PDGA round is the one its published ratings imply. PDGA rates the rounds of one event on one layout from a shared SSA, so the live API's per-round `SSARdN` can be off by up to 0.8 strokes. One example is the Down East Players Cup 2025 on Farmville Hybrid: SSARd 53.42 and 52.07, with both rounds' published ratings implying 52.83. The implied SSA, the median over players, is stored in `ratings_ssa` when it differs from SSARdN by more than 0.1 strokes. Otherwise SSARdN is kept, because integer ratings only pin the SSA to a few hundredths of a stroke.

Data comes only from the public PDGA JSON endpoints:

- Discovery reads members' `/api/v1/feat/members/<n>/rating-detail` and keeps events from the last three years, in a state where we have courses and a town with one of our courses. One typo is tolerated in town names of seven or more letters ("Greenivlle"), and a ZIP-code city falls back to the state check.
- Events in a member's rating history have published ratings and are marked official. Events an admin adds by number stay "unconfirmed" until one appears in a rating history.
- The hourly cron reads at most 10 PDGA URLs per tick and resumes an event across ticks. On failure it backs off for 1, 4, 12, 24 and 72 hours before marking the event failed. pdga.com answered HTTP 429 to about 200 requests sent 0.6 s apart.
- Only (score, round rating) pairs are stored, per division, with no names or PDGA numbers.

Course candidates are our courses in the event's state that share a distinctive name word with PDGA's course name, plus every course in the event's town. PDGA calls ECU North Rec "East Carolina University". Hole geometry then decides, and two equally close layouts are never matched automatically.

### Validation against PDGA's own ratings

`GET /admin/pdga-baselines/validation` (Course health → PDGA rated rounds → Prediction check) walks forward through matched PDGA rounds layout by layout. It predicts each round from the baseline of matched rounds from earlier events. Every published (score, round rating) pair in that round is rated as the engine would rate it, from that no-wind baseline plus the round's own gust adjustment, and compared with the rating PDGA published. Same-event rounds are excluded, because a round played the day before in the same event would flatter the result. The report gives mean absolute error and signed bias in rating points, the SSA error in strokes, and the counts behind them. Below 30 pairs or three predicted rounds it is labelled a small sample. It also reports:

- Formula check: each pair is rated from the round's published SSARdN.
- Club comparison: stored club layout baselines next to the PDGA baseline available on the same date.

Measured on 2026-11-17 by a dry run against real public data (an in-memory database, not the live D1):

- Input: 17 local events from one member's public rating history, 2024-01 to 2026-07 (Greenville, Ayden, Winterville and Farmville). This was 292 PDGA requests at 1.5 s spacing, cached for reruns, giving 41 PDGA rounds and 25 PDGA layouts.
- Matching: 11 layouts matched automatically (1 exact, 10 close) on six of our layouts:
  - Ayden Park Main;
  - Covenant Church Covey;
  - ECU North Rec 2024 DEPC Purple;
  - West Meadowbrook Purple and Gold;
  - Oakwood Eagles' Nest.
- Review: one layout was left ambiguous (Ayden Park Main vs Alternate Pad) and 13 were left for review (tournament layouts whose pars or lengths differ).
- Wind: all 20 matched PDGA rounds got a gust from 9 archive requests. Gusts ranged from 13.6 to 35.3 mph, and 16 rounds were above the model's 18 mph threshold.
- Prediction: 7 rounds on 4 layouts could be predicted from earlier events, covering 199 published ratings.

| Baseline | Mean abs. error (rating pts) | Bias (pts) | SSA error (strokes) |
|---|---|---|---|
| All earlier rounds, as played | 18.1 | +18.1 | 1.25 (bias +1.25) |
| 6 most recent within 3 years, as played | 18.1 | +18.1 | 1.25 (bias +1.25) |
| 6 most recent within 3 years, wind-normalised | 14.7 | +13.9 | 1.06 (bias +1.01) |

The recency window changed nothing here because no layout had more than six matched rounds in three years. Wind normalisation removed about a fifth of the error. Most predicted rounds still played easier than earlier events on their layout. This is a small, real sample, not a general accuracy figure.

- Formula check: from SSARdN the engine reproduced 797 published ratings within 2.1 points on average, with a largest gap of 10 from shared-SSA rounds. On layouts an event played only once, it matched 312 of 445 exactly, was one point high on 113, one low on 17 and two high on 3. PDGA published 974 where `1000 + (SSA − score) × ppt` gives 974.6.
- Club comparison: there were no club layout baselines in this dry run.

### Tuning on a wider sample (2026-11-17)

The 7-round sample above was too small to tune anything, so the evidence was widened first:

- Discovery used the public rating histories of the 80 most regular players from the 17 seed events, out of 400 players.
- That found 629 local events in the 3-year window and towns-with-our-courses filter, and 36 new ones were read.
- For new events, only enough divisions per round were read to see each layout.
- The cost was exactly 400 new pdga.com requests at 1.6 s spacing (no HTTP 429s), plus 23 Open-Meteo archive requests. Every body is cached outside the repository.

The resulting dataset:

- 53 events, 157 PDGA rounds, 101 PDGA layouts.
- 67 rounds from 28 events (2024-04 to 2026-11) matched 10 of our layouts. West Meadowbrook Purple had 21 rounds and Gold 13; Covenant Covey, Ayden Park Main, ECU DEPC Purple, ECU Gold and Oakwood Eagles' Nest had 5–7 each.
- Every matched round has wind and temperature: gusts 11–35 mph (42 above 18 mph), temperature 47–91 °F.

Method: leave one event out. Each event's published ratings are predicted only from other events played on earlier days on the same layout. The prediction is the baseline plus the event's own conditions, rated as the engine rates a round. That gives 52 predicted rounds from 19 events and 1,784 published ratings.

- Every candidate is compared with the current model by the paired per-event difference in mean absolute error, with a 95% interval over the 19 events.
- Fitted parameters (gust slope, temperature slope, time trend) are re-fitted without the held-out event.
- Regressions are run within layouts at the event-day level, because rounds of one event on one day share their wind and often their SSA.

The harness is `GVDG_RATING_TUNING=1 GVDG_RATING_TUNING_CACHE=<dir> npx vitest run test/rating-tuning-research.test.ts`. Add `GVDG_RATING_TUNING_FETCH=1` to allow network reads.

| Candidate | MAE (pts) | Bias (pts) | Per-event Δ MAE vs current (95% CI) |
|---|---|---|---|
| **Current: median of 6 most recent in 3 years, gust 0.035/mph over 18 (cap 1.5)** | **13.5** | **−5.9** | — |
| No wind normalisation | 14.4 | −6.2 | +1.3 (+0.4 to +2.2), worse |
| Gust 0.02/mph over 18 | 13.8 | −6.0 | +0.4 (+0.1 to +0.7), worse |
| Gust 0.05 / 0.07 / 0.10 per mph over 18 | 13.5 / 13.5 / 13.6 | −5.8 / −5.7 / −5.4 | 0.0 / 0.0 / −0.3 (CIs ±0.5 to ±2) |
| Gust 0.035 over 0 / 10 / 14 mph | 13.9 / 13.4 / 13.3 | −7.0 / −6.1 / −5.8 | 0.0 / −0.1 / −0.2 (CIs include 0) |
| Gust slope fitted per held-out event | 14.2 | −4.6 | −0.4 (−6.2 to +5.4) |
| Median of 4 / 8 / 12 / all in 3 years | 13.5 / 13.2 / 13.0 / 13.0 | −5.9 / −6.5 / −6.8 / −6.9 | −0.5 / −0.3 / −1.2 / −1.2 (CIs include 0) |
| Weighted median, half-life 6 / 12 / 24 months | 13.7 / 13.0 / 13.3 | −6.5 / −6.2 / −6.3 | +1.1 / −2.1 (−4.1 to −0.1) / −1.6 (−3.5 to +0.2) |
| Mean / 20% trimmed mean of 6 | 13.3 / 13.2 | −7.3 / −7.0 | −0.7 / −0.6 (CIs include 0) |
| Temperature fitted per held-out event | 11.2 | −5.1 | −1.4 (−4.6 to +1.9) |
| Temperature-normalised baseline only | 11.5 | −1.3 | −0.4 (−3.1 to +2.4) |
| Gust and temperature fitted jointly | 13.9 | −5.3 | −0.2 (−6.5 to +6.0) |
| Linear time trend fitted per held-out event | 13.4 | −3.4 | +0.6 (−1.8 to +2.9) |

The regressions, within layouts at the event-day level (n = 37 over 7 layouts):

- SSA rises 0.21 strokes per mph of gust above 18 (95% CI 0.10–0.32), or 0.18 per mph on a linear scale (0.09–0.27).
- Temperature alone: −0.056 strokes per °F (−0.109 to −0.003).
- Fitted together: gust 0.185 (0.066–0.304) and temperature −0.028 (−0.078 to +0.021). The two are correlated (r = −0.35) because the cooler months are windier.

Decision: no engine or baseline parameter changed, so no club or PDGA rating changes.

- Wind normalisation is confirmed: removing it, or halving the coefficient, is clearly worse.
- The regression says gusts matter several times more than 0.035 per mph. Using a larger coefficient does not improve held-out prediction, though, and the fitted slope is unstable from one held-out event to the next.
- The coefficient also drives every club round's live weather adjustment, so it was left unchanged.
- Recency, half-life weighting, the statistic and the threshold differ by less than their uncertainty. The one interval that excludes zero (half-life 12 months) was picked from a grid of three, so it is not evidence on its own.
- Temperature shows the largest pooled gain. Its per-event interval includes zero, and its effect largely disappears once gust is in the model. Club rounds also do not store temperature yet.

Recommended for a later re-test, once the hourly ingest has gathered more events:

- a larger gust coefficient, around 0.07–0.2 per mph above 18;
- recency by a 12-month half-life;
- a temperature term. This would first need the club to store each round's temperature at finalize.

The dry run is `GVDG_PDGA_DRY_RUN=1 GVDG_PDGA_DRY_RUN_EVENTS=<ids> GVDG_PDGA_DRY_RUN_CACHE=<dir> npx vitest run test/pdga-baseline-dry-run.test.ts` in `auth-worker`. It loads our public course list into an in-memory database and runs the production ingest path against pdga.com, caching the responses so a rerun makes no requests.
