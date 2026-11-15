import ActivityKit
import CoreLocation
import SwiftUI
import UIKit

@MainActor
final class ActivitySession: NSObject, ObservableObject, @preconcurrency CLLocationManagerDelegate {
    @Published private(set) var track: ActivityTrack?
    @Published private(set) var settings = ActivitySettings()
    @Published private(set) var routes: [ActivityTrack] = []
    @Published private(set) var fix: GPSPoint?
    @Published private(set) var running = false
    @Published private(set) var busy = false
    @Published var message = ""

    private let manager = CLLocationManager()
    private var journal: ActivityJournal?
    private var requested: Bool?
    private var live: Activity<RoundActivityAttributes>?
    private var lastUpdate: Int64 = 0
    private var liveRevision = 0

    var ownsActive: Bool {
        guard let track, let owner = track.ownerId else { return true }
        return owner == settings.device?.memberId
    }
    var connected: Bool { settings.device.map { $0.expiresAt > WallClock.now } ?? false }
    var code: String? { (settings.codeExpiresAt ?? 0) > WallClock.now ? settings.code : nil }

    override init() {
        super.init()
        manager.delegate = self
        manager.activityType = .fitness
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 4
        manager.pausesLocationUpdatesAutomatically = false
        manager.showsBackgroundLocationIndicator = true
        Task {
            for old in Activity<RoundActivityAttributes>.activities {
                await old.end(nil, dismissalPolicy: .immediate)
            }
        }
        do {
            let journal = try ActivityJournal()
            self.journal = journal
            settings = try journal.settings()
            if var saved = try journal.current() {
                if saved.stage == .tracking {
                    saved.stage = .paused
                    saved.newSegment = true
                    try journal.save(saved)
                    message = "Recording was interrupted. Resume to start a new section."
                }
                track = saved
            }
            try reloadRoutes()
        } catch { message = "Activity storage could not be opened." }
    }

    private func local() throws -> ActivityJournal {
        guard let journal else { throw ActivityFailure.storage }
        return journal
    }

    private func save(_ current: ActivityTrack) throws {
        try local().save(current)
        track = current
    }

    private func set(_ next: ActivitySettings) throws {
        try local().save(settings: next)
        settings = next
    }

    private func reloadRoutes() throws { routes = try local().completed(owner: settings.device?.memberId) }

    func start() {
        guard !running && !busy && ownsActive else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            requested = track == nil
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            begin(new: track == nil)
        default:
            message = "Allow precise location in Settings to record an activity."
        }
    }

    private func begin(new: Bool) {
        guard UIApplication.shared.applicationState != .background else { return }
        guard manager.accuracyAuthorization == .fullAccuracy else {
            message = "Turn on Precise Location for this app in Settings."
            return
        }
        do {
            let now = WallClock.now
            if new {
                guard track == nil else { return }
                try save(ActivityTrack(owner: settings.device?.memberId,
                    round: connected ? settings.device?.round?.binding : nil, now: now))
            } else if var current = track {
                guard ownsActive && now < current.startedAt + ActivityTrack.maxTime && current.pointCount < ActivityTrack.maxPoints
                else { message = "This activity reached its recording limit. Stop and save it."; return }
                current.stage = .tracking
                current.newSegment = true
                try save(current)
            } else { return }
            running = true
            fix = nil
            message = ""
            manager.allowsBackgroundLocationUpdates = true
            manager.startUpdatingLocation()
            publishLive(force: true)
        } catch {
            message = "Could not save the activity on this phone. Check device storage."
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if let wanted = requested {
                requested = nil
                begin(new: wanted)
            } else if running && manager.accuracyAuthorization != .fullAccuracy {
                pause(message: "Precise location is off. Activity paused.")
            }
        case .denied, .restricted:
            requested = nil
            if running { pause(message: "Location permission changed. Activity paused.") }
            else { message = "Allow precise location in Settings to record an activity." }
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running else { return }
        let now = WallClock.now
        for location in locations.sorted(by: { $0.timestamp < $1.timestamp }) {
            guard let current = track, location.sourceInformation?.isSimulatedBySoftware != true else { continue }
            let sample = GPSPoint(at: Int64(location.timestamp.timeIntervalSince1970 * 1000),
                                  lat: location.coordinate.latitude, lng: location.coordinate.longitude,
                                  accuracyM: location.horizontalAccuracy)
            guard sample.at >= current.startedAt, sample.isFresh(at: now), sample.at > (fix?.at ?? 0) else { continue }
            var edited = current
            do {
                if try edited.append(sample) { try save(edited) }
                fix = sample
            } catch ActivityFailure.limit {
                pause(message: "Recording reached its limit. Stop and save the activity.")
                return
            } catch {
                pause(message: "Device storage could not save the last fix. The earlier route is intact.")
                return
            }
        }
        publishLive(force: false)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied && running { pause(message: "Location is unavailable. Activity paused.") }
    }

    func pause(message: String = "Activity paused.") {
        guard ownsActive, var current = track else { return }
        suspendLocation()
        self.message = message
        current.stage = .paused
        current.newSegment = true
        do { try save(current) }
        catch { self.message = "Recording is paused. The device could not save the pause state." }
        publishLive(force: true)
    }

    func stop() {
        guard ownsActive, var current = track else { return }
        suspendLocation()
        do {
            current.stop(now: WallClock.now)
            try save(current)
            try local().storeCompleted(current)
            try local().clearActive()
            track = nil
            try reloadRoutes()
            message = "Activity saved on this phone."
        } catch { message = "Could not confirm the saved activity. Free device storage and try again." }
        endLive()
    }

    private func suspendLocation() {
        running = false
        fix = nil
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
    }

    func choose(_ hole: Int) {
        do {
            var next = settings
            next.hole = hole
            try set(next)
            publishLive(force: true)
        } catch { message = "Could not save the selected hole." }
    }

    func showLockDistance(_ enabled: Bool) {
        do {
            var next = settings
            next.lockDistance = enabled
            try set(next)
            if enabled && !ActivityAuthorizationInfo().areActivitiesEnabled {
                message = "Allow Live Activities in Settings to see distance on the lock screen."
            }
            publishLive(force: true)
        } catch { message = "Could not save the lock screen preference." }
    }

    func range(at now: Int64) -> Int? {
        guard running, let fix, fix.isFresh(at: now), let basket = settings.basket(at: now),
              basket.lat.isFinite, basket.lng.isFinite else { return nil }
        return Int((ActivityTrack.distance(fix.lat, fix.lng, basket.lat, basket.lng) * 3.2808399).rounded())
    }

    private func publishLive(force: Bool) {
        guard let track else { return }
        let now = WallClock.now
        guard force || now - lastUpdate >= 12_000 else { return }
        let expectsFix = running && settings.lockDistance && settings.basket(at: now) != nil
        let state = RoundActivityAttributes.ContentState(status: running ? "Recording" : "Paused",
            basketFeet: expectsFix ? range(at: now) : nil, expectsFix: expectsFix)
        let expiry = fix.map { Date(timeIntervalSince1970: Double($0.at + 45_000) / 1000) }
        let content = ActivityContent(state: state, staleDate: expectsFix ? expiry : nil)
        lastUpdate = now
        liveRevision += 1
        let revision = liveRevision
        if let live {
            Task {
                guard revision == liveRevision else { return }
                await live.update(content)
            }
        } else if running && ActivityAuthorizationInfo().areActivitiesEnabled,
                  UIApplication.shared.applicationState == .active, let id = UUID(uuidString: track.clientId) {
            do { live = try Activity.request(attributes: RoundActivityAttributes(sessionID: id), content: content, pushType: nil) }
            catch { /* The recording remains available without a Live Activity. */ }
        }
    }

    private func endLive() {
        liveRevision += 1
        if let live {
            self.live = nil
            Task { await live.end(nil, dismissalPolicy: .immediate) }
        }
    }

    func pair() async {
        guard !busy && !running else { return }
        busy = true
        defer { busy = false }
        do {
            let pair = try await ActivityAPI.begin()
            guard !running else { return }
            try ActivityCredential.write(pair.token)
            var next = settings
            next.device = nil
            next.hole = nil
            next.code = pair.code
            next.codeExpiresAt = pair.expiresAt
            try set(next)
            try reloadRoutes()
            message = "Enter the code on the club website."
        } catch { message = "Could not get a pairing code. Check the connection and try again." }
    }

    func connect() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let token = try ActivityCredential.read() else {
                message = "Get a pairing code to connect."
                return
            }
            let (status, grant) = try await ActivityAPI.connect(token: token)
            var next = settings
            if status == 401 {
                next.device?.expiresAt = 0
                next.device?.round = nil
                next.code = nil
                try set(next)
                publishLive(force: true)
                message = "This connection expired or was removed. Pair again with the same account to upload its routes."
            } else if let grant {
                guard settings.device?.memberId == nil || settings.device?.memberId == grant.memberId else {
                    message = "The account changed. Pair again."
                    return
                }
                next.device = grant
                next.code = nil
                try set(next)
                try reloadRoutes()
                publishLive(force: true)
                message = grant.roundUnavailable ? "Connected. The paired scorecard is no longer available." : "Club account connected."
            } else {
                message = "Enter the pairing code on the club website, then check again."
            }
        } catch { message = "Could not check the connection. Try again when online." }
    }

    func upload(_ route: ActivityTrack) async {
        guard !busy, let grant = settings.device, grant.expiresAt > WallClock.now else { return }
        busy = true
        defer { busy = false }
        do {
            guard let token = try ActivityCredential.read(),
                  var saved = try local().loadCompleted(route.clientId),
                  saved.ownerId == nil || saved.ownerId == grant.memberId else { throw ActivityFailure.ownership }
            if saved.ownerId == nil {
                saved.ownerId = grant.memberId
                try local().storeCompleted(saved)
            }
            let (status, receipt) = try await ActivityAPI.upload(saved, token: token)
            if let receipt, receipt.clientId == saved.clientId, receipt.id > 0 {
                saved.serverId = receipt.id
                try local().storeCompleted(saved)
                try reloadRoutes()
                message = "Route uploaded to your private club archive."
            } else if status == 410 {
                message = "This route was removed from the archive. Your phone copy is intact."
            } else if status == 401 || status == 403 {
                message = "Connect the route’s original account and try again."
            } else if status == 409 {
                message = "The archive already has different data for this route. Your phone copy is intact."
            } else { message = "The route is still on this phone. Retry upload when connected." }
        } catch { message = "The route is still on this phone. Check the connection or storage and retry." }
    }

    func remove(_ route: ActivityTrack) {
        do {
            guard !busy, let saved = try local().loadCompleted(route.clientId),
                  saved.ownerId == nil || saved.ownerId == settings.device?.memberId else { throw ActivityFailure.ownership }
            try local().remove(saved.clientId)
            try reloadRoutes()
            message = "Route removed from this phone."
        } catch { message = "Could not remove the route from this phone." }
    }
}
