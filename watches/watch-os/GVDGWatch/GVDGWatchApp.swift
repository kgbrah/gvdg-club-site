import CoreLocation
import SwiftUI

@main
struct GVDGWatchApp: App {
    var body: some Scene {
        WindowGroup { ScorerView() }
    }
}

@MainActor
final class WatchRange: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var fix: CLLocation?
    @Published private(set) var enabled = false
    @Published private(set) var permissionDenied = false
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 2
    }

    func enable() {
        enabled = true
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        start()
    }

    func start() {
        guard enabled else { return }
        permissionDenied = manager.authorizationStatus == .denied || manager.authorizationStatus == .restricted
        if manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse {
            manager.startUpdatingLocation()
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        fix = nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        start()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        fix = locations.last
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        fix = nil
    }

    func feet(to basket: WatchCard.Basket) -> Int? {
        guard let fix, fix.horizontalAccuracy >= 0, fix.horizontalAccuracy <= 20,
              abs(fix.timestamp.timeIntervalSinceNow) < 20 else { return nil }
        let target = CLLocation(latitude: basket.lat, longitude: basket.lng)
        return Int((fix.distance(from: target) * 3.28084).rounded())
    }
}

struct ScorerView: View {
    @Environment(\.scenePhase) private var phase
    @StateObject private var session = ScoreSession()
    @StateObject private var range = WatchRange()
    @State private var showReview = false
    @State private var showDiscard = false
    @State private var showClear = false

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if let card = session.journal.card, let hole = session.hole {
                    scorecard(card, hole: hole)
                } else {
                    pairing
                }
                if !session.notice.isEmpty { Text(session.notice).font(.footnote).foregroundStyle(.secondary) }
            }
            .padding(.horizontal, 3)
        }
        .task(id: phase) {
            guard phase == .active else { range.stop(); return }
            range.start()
            while !Task.isCancelled {
                await session.sync()
                try? await Task.sleep(for: .seconds(session.journal.queued.isEmpty ? 2 : 1))
            }
        }
        .confirmationDialog("Use phone scores?", isPresented: $showDiscard) {
            Button("Use phone scores", role: .destructive) { Task { await session.refresh(discard: true) } }
        } message: {
            Text("Connecting will replace the saved edits on this watch with the current card.")
        }
        .confirmationDialog("Clear saved card?", isPresented: $showClear) {
            Button("Clear card", role: .destructive) { session.clear(); range.stop() }
        } message: {
            Text(session.journal.queued.isEmpty ? "Pair a new code to score again." : "This removes the scores waiting on this watch.")
        }
        .sheet(isPresented: $showReview) {
            List {
                Text("Saved on this watch").font(.headline)
                ForEach(session.journal.queued) { edit in
                    let name = session.journal.card?.targets.first { $0.id == edit.targetId }?.name ?? "Player"
                    Text("Hole \(edit.hole) · \(name) · \(edit.strokes.map { String($0) } ?? "Cleared")")
                }
                Button("Close") { showReview = false }
            }
        }
    }

    private var pairing: some View {
        VStack(spacing: 8) {
            Text("GVDG").font(.title2.bold()).foregroundStyle(.green)
            if session.journal.code.isEmpty {
                Text("Pair your watch").font(.headline)
                Button("Get a code") { Task { await session.pair() } }.disabled(session.busy || session.storageFailed)
            } else {
                let code = session.journal.code
                Text("\(code.prefix(4)) \(code.suffix(4))").font(.title2.monospaced().bold())
                Text("Enter at \(WatchAPI.phoneSite) in your scorecard’s Pair a watch menu.").font(.footnote)
                Button("Check pairing") { Task { await session.refresh(discard: false) } }.disabled(session.busy)
                Button("New code") { Task { await session.pair() } }.disabled(session.busy || session.storageFailed)
            }
            if session.storageFailed { Button("Clear watch data", role: .destructive) { showClear = true } }
        }
        .multilineTextAlignment(.center)
    }

    private func scorecard(_ card: WatchCard, hole: WatchCard.Hole) -> some View {
        VStack(spacing: 7) {
            Text(card.courseName ?? "GVDG").font(.caption).foregroundStyle(.green).lineLimit(2)
            Text(card.putting ? "Station \(hole.hole)" : "Hole \(hole.hole) · Par \(hole.par)").font(.headline)
            HStack {
                Button { session.moveHole(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous hole")
                Button { session.moveHole(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next hole")
            }.disabled(card.holes.count < 2)
            if !card.putting { rangeView(hole) }
            ForEach(card.targets) { target in
                ScoreRow(name: target.name, vote: session.journal.displayedVote(for: target, hole: hole.hole),
                         confirmed: target.scores[String(hole.hole)], conflict: target.conflicts.contains(hole.hole),
                         min: card.putting ? 0 : 1, max: card.putting ? Swift.min(10, hole.par) : 30,
                         seed: card.putting ? 0 : hole.par, enabled: session.canEdit) { score in
                    session.record(score, for: target, on: hole.hole)
                }
            }
            if !session.journal.queued.isEmpty {
                Button("Saved edits · \(session.journal.queued.count)") { showReview = true }
            }
            if !session.journal.blocked.isEmpty {
                Text(session.journal.blocked).font(.footnote)
                Button("Load phone scores") {
                    if session.journal.queued.isEmpty { Task { await session.refresh(discard: true) } }
                    else { showDiscard = true }
                }.disabled(session.busy)
            } else if card.locked {
                Text("Card closed").font(.footnote)
            }
            if session.storageFailed { Button("Retry storage") { session.retryStorage() } }
            if card.locked || !session.journal.blocked.isEmpty || session.journal.queued.isEmpty {
                Button("Clear this card", role: .destructive) { showClear = true }.disabled(session.busy)
            }
        }
        .multilineTextAlignment(.center)
    }

    @ViewBuilder private func rangeView(_ hole: WatchCard.Hole) -> some View {
        if let basket = hole.basket, range.enabled {
            TimelineView(.periodic(from: .now, by: 5)) { _ in
                if let feet = range.feet(to: basket) { Text("\(feet) ft to basket").foregroundStyle(.green).font(.footnote.bold()) }
                else { Text(range.permissionDenied ? "Allow location in Settings" : "Waiting for a GPS fix").font(.footnote) }
            }
        } else {
            if let feet = hole.distanceFt { Text("\(Int(feet.rounded())) ft listed").font(.footnote) }
            if hole.basket != nil { Button("GPS range") { range.enable() } }
        }
    }
}

private struct ScoreRow: View {
    let name: String
    let vote: Int?
    let confirmed: Int?
    let conflict: Bool
    let min: Int
    let max: Int
    let seed: Int
    let enabled: Bool
    let changed: (Int?) -> Void
    @State private var showOptions = false

    var body: some View {
        VStack(spacing: 2) {
            Text(name).font(.footnote.bold())
            if conflict { Text("Check card").font(.caption2).foregroundStyle(.orange) }
            else if vote == nil, let confirmed { Text("Card \(confirmed)").font(.caption2).foregroundStyle(.secondary) }
            HStack(spacing: 3) {
                Button("−") { if let vote { changed(vote - 1) } }
                    .disabled(!enabled || (vote ?? min) <= min).accessibilityLabel("Lower score for \(name)")
                Button(vote.map { String($0) } ?? "–") { showOptions = true }
                    .disabled(!enabled).accessibilityLabel("Set score for \(name), \(vote.map { String($0) } ?? "unentered")")
                Button("+") { changed(vote.map { $0 + 1 } ?? seed) }
                    .disabled(!enabled || (vote ?? min) >= max).accessibilityLabel("Raise score for \(name)")
            }
        }
        .sheet(isPresented: $showOptions) {
            List {
                Text(name).font(.headline)
                ForEach(min...Swift.max(min, max), id: \.self) { score in
                    Button(String(score)) { changed(score); showOptions = false }
                }
                Button("Clear score", role: .destructive) { changed(nil); showOptions = false }
            }
        }
    }
}
