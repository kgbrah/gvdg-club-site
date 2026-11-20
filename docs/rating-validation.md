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

## PDGA layout baselines (removed 2026-11-20)

Club rounds used to be rated against SSAs from PDGA tournament rounds on matching layouts. Those PDGA rounds were
discovered through pdga.com endpoints PDGA hasn't made available to developers and were stored permanently, which
PDGA's Developer Program does not allow (its API license permits temporary caching only). The PDGA Developer Program
asked the club to stop, so migration `0078_pdga_compliance.sql` deleted every stored PDGA round, match and validation
record, unrated the club rounds that had been rated from them, and queued those rounds for re-rating from club data.

Club ratings now come only from club fields (the day-of solve, or an earlier club field's calibration for casual
rounds). Members' current PDGA ratings, read through the PDGA REST API, still anchor club fields; each is kept only
while the API keeps confirming it (refreshed daily) and for 7 days after (`ratings-recompute.ts`).
