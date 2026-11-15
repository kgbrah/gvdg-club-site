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
