# Native GVDG watch scorers

Open the GVDG watch app and get a pairing code. In your phone browser, open an active private GVDG scorecard and enter the code under **Pair a watch**. Use the site named on the watch display. The five-minute code grants the watch access to this round and your scorecard for up to 72 hours. You can remove the watch in the phone’s pairing panel.

The watch enters scores under your own scorer identity. Singles, doubles, match play and putting use the round’s existing score targets and bounds. The phone remains the place to start or finish a round, score on behalf of a guest, and resolve card consensus. Event guests with only a registration link can score on the phone. Signed-in members and casual open-play players can pair their own watch.

The watch downloads a card after pairing and can then save scores offline. Open the watch app to resume synchronization. If a queued edit is based on a score that changed on the phone, the watch pauses its queue and lets you review your saved edits. Loading phone scores replaces the watch’s pending edits after the watch successfully reconnects. Use the phone to apply any scores you want to keep from a paused queue.

| Client | Capabilities | Build and verification |
| --- | --- | --- |
| Wear OS (Android API 28+) | Native scoring, cached card, durable score queue, basket distance and a local last-throw measurement using foreground GPS | `cd watches/wear-os && ./gradlew :app:assembleDebug :app:lintDebug` with JDK 21, Android SDK Platform 35 and Build Tools 35.0.0. Debug APK and lint were verified on Linux. |
| Apple Watch (watchOS 10+) | Watch-only SwiftUI scoring, cached card, durable score queue, foreground basket distance | Build scheme `GVDGWatch` in Xcode for watchOS Simulator. GitHub Actions builds the unsigned simulator bundle. Swift protocol code type-checked on Linux, which has no watchOS SDK. |
| Browser wrist layout | Compact browser scorer, existing GPS readout, optional distance notifications | Run the phone scorer’s existing wrist layout. Browser distance notifications depend on OS settings and update while the scorer can run in the foreground. |

The debug clients pair with `gvdgclub.com`. Release clients are configured for `greenvillediscgolf.com`. Distance tools need a usable location fix and a mapped basket for the current hole. Wear OS measures a throw between two fixes on the watch and displays the last result during that session. Neither native client sends its GPS fixes to GVDG.

Physical watches and store distribution require the relevant hardware, platform signing, and account access. Before a release, verify pairing, restart while offline, reconnect during an interrupted submission, concurrent phone and watch edits, revocation, missing basket coordinates, and battery use over an entire round on each intended device family.
