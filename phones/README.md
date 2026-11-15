# GVDG Activity for iPhone and Android

Open the app and tap **Start activity** to request precise location and record a private walk. Pause stops location collection. Resume starts a new route segment. Stop saves the route on the phone. Routes stay on the phone until the player chooses **Upload** and confirms that the club account will receive precise GPS positions and timestamps. The phone keeps its copy when a request fails. Retrying the same upload returns the original receipt.

Use **Connect** to generate a five-minute code. Approve it from the website with a member account. Pairing from a live scorecard also grants read access to the baskets on that card for as long as the member remains assigned to it. The phone's **Choose hole** control selects a saved basket. The app can show the resulting GPS distance on the lock screen after the player enables it. Device grants last 30 days and can be revoked in the website. Switching accounts preserves the original owner of previously linked routes. An unlinked route can be explicitly linked on its first upload.

The iPhone uses Core Location background updates and an embedded ActivityKit widget extension. The widget receives a distance and the GPS freshness deadline from the app. Android uses a user-started location foreground service and a private notification. The notification offers Pause and Stop. The OS controls whether lock-screen details appear. An interrupted recorder resumes only when the player asks. Pauses and gaps between fixes do not add distance.

The member website lists uploaded routes and offers private download and removal. The API supports JSON with original validated fixes and GPX with timestamps. No route modifies the scorecard or enters rankings or ratings.

## Build and test

| Target | Build command | Output |
| --- | --- | --- |
| iPhone Simulator, iOS 16.2 or newer | Run `xcodebuild -project GVDGPhone.xcodeproj -scheme GVDGPhone -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` in `phones/ios` | Unsigned simulator app with embedded Live Activity extension |
| Android 9 or newer | Run `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest` in `phones/android` with JDK 17 or newer and API 35 | Debug APK and unit tests |

The GitHub Actions workflow **Build native phone activity apps** runs these builds. The build defaults to the shared development site at gvdgclub.com. To build against production explicitly, set `GVDG_SITE_HOST=greenvillediscgolf.com` in the Xcode build or pass `-PactivityProduction=true` to Gradle. The server deployment must contain migration 0056 and the activity API at the selected site.

Physical-device testing covers background fixes during screen lock, denied or reduced location permission, a disabled GPS provider, process termination, and stale lock-screen readings. Simulator and debug builds do not establish physical location behavior or store availability. A signed device build and distribution need the corresponding platform signing credentials.
