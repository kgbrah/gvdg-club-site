# Field verification before parity claims

Status: not run. Automated browser, database and native-build checks do not establish physical-device reliability, battery performance, or equality with UDisc Pro. Use club volunteers who already own the intended devices; the project owner does not wear a watch.

Volunteers run this with the field test kit: the printable checklist at [`field-test.html`](../field-test.html), Field test mode and the Field log in the member app, and `scripts/field/summarize-logs.mjs` to compare the exported logs. See [field-test-kit.md](field-test-kit.md).

## Record the test conditions

Record the app commit, installed app version, phone/watch model, OS version, course and layout revision, mapped-hole coverage, network conditions, battery health and starting charge. For a comparison, record the current UDisc version and subscription capabilities as observed on the test device. Use the same course, route, screen brightness and tasks. Alternate app order across repeats so weather and battery conditions do not always favor one app.

Minimum device coverage is one iPhone and one Android phone for browser workflows, plus each supported native watch family. The native source currently targets watchOS 10+, Android API 28+ on Wear OS, and Garmin Forerunner 970 / Venu 4 profiles. Build evidence is documented separately in `watches/README.md`; it does not establish support on every model.

## Round recovery matrix

Run an 18-hole, four-player round and a doubles round. Include a missed short putt, penalty, changed basket, corrected score, two throws from the same position, incomplete shot recording and at least two video clips. Check each player's separate records as well as team observations.

Repeat with airplane mode, a closed/reopened app, a phone restart, a 48-hour interruption, expired authorization, account switching, low storage, lost upload responses, reconnect flapping and concurrent phone/watch edits. Test starting from a saved course pack separately from resuming an already downloaded online card.

Acceptance criteria:

- Exact score totals and one authoritative final result, with no silent loss or duplicate submission.
- Every saved shot and completed clip is either retrievable or visibly pending with a recovery path.
- No cross-account records appear or upload under a different owner.
- A stale edit requires review; it never silently overwrites a newer score.
- Incomplete maps, unknown shot outcomes and unverified historical geometry remain labeled.
- A final round remains available after the app and device restart.

## Usability and accessibility

Have a new member start/join/watch a round, register for an event, find a saved clip, review a stat definition and locate their wallet. Have a new admin approve an application, check in players, open live scoring, fulfill an order, edit a layout and review a tee sign. Record successful completion, taps, time, backtracks and requests for help.

Repeat critical tasks with large text, keyboard navigation, VoiceOver or TalkBack, and bright outdoor light. Check focus restoration, announced save/conflict states, text contrast, reachable controls and horizontal overflow. No critical action may require an unlabeled icon, color alone or an inaccessible gesture.

## Paired measurements

Measure score-entry feedback time, successful round completion, lost/duplicate records, correction effort, spectator update delay, clip availability and battery change per hour. Capture slow-network and interrupted-network results separately from ordinary connected play. Report device-specific samples, medians and ranges; do not combine untested devices into a broad reliability claim.

The intended parity target is no worse than the comparison app for shared tasks, while demonstrating the added customization, private analysis and saved-video workflows separately. Any data-loss, privacy, authorization or accessibility blocker fails the release regardless of average speed. Publish the actual measurements and unresolved failures before claiming superiority.

Native store distribution also requires the platform account/signing access and successful physical-device checks. A simulator bundle or generic Garmin compile is not a downloadable store release.
