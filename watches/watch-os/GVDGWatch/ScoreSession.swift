import Foundation
import SwiftUI

@MainActor
final class ScoreSession: ObservableObject {
    @Published private(set) var journal = WatchJournal()
    @Published private(set) var busy = false
    @Published private(set) var notice = ""
    @Published private(set) var storageFailed = false
    @Published private(set) var holeIndex = 0
    private let store = JournalStore()
    private let api = WatchAPI()
    private var nextAttempt = Date.distantPast

    init() {
        do {
            journal = try store.read()
            goToStartingHole()
        } catch {
            storageFailed = true
            notice = "The saved card could not be opened."
        }
    }

    var hole: WatchCard.Hole? {
        guard let holes = journal.card?.holes, holes.indices.contains(holeIndex) else { return nil }
        return holes[holeIndex]
    }

    var canEdit: Bool {
        journal.card?.locked == false && journal.blocked.isEmpty && !storageFailed
    }

    func moveHole(_ step: Int) {
        guard let count = journal.card?.holes.count, count > 0 else { return }
        holeIndex = (holeIndex + count + step) % count
    }

    private func goToStartingHole() {
        holeIndex = journal.card?.holes.firstIndex(where: { $0.hole == journal.card?.startingHole }) ?? 0
    }

    @discardableResult
    private func persist(_ updated: WatchJournal) -> Bool {
        do {
            try store.write(updated)
            journal = updated
            storageFailed = false
            return true
        } catch {
            storageFailed = true
            notice = "Watch storage is unavailable. Free space, then retry."
            return false
        }
    }

    func retryStorage() {
        if persist(journal) {
            notice = ""
            nextAttempt = .distantPast
        }
    }

    func record(_ strokes: Int?, for target: WatchCard.Target, on hole: Int) {
        guard canEdit else { return }
        guard journal.queued.count < 180 else {
            notice = "Sync the saved scores before adding more."
            return
        }
        var proposed = journal
        proposed.append(target: target, hole: hole, strokes: strokes)
        if proposed != journal && persist(proposed) { nextAttempt = .distantPast }
    }

    func clear() {
        guard !busy, persist(WatchJournal()) else { return }
        holeIndex = 0
        notice = ""
        nextAttempt = .distantPast
    }

    func pair() async {
        guard !busy, !storageFailed, journal.card == nil else { return }
        busy = true
        defer { busy = false }
        notice = "Requesting a code…"
        do {
            let reply = try await api.request(PairingReply.self, path: "pairings", method: "POST")
            guard reply.code.count == 8, !reply.token.isEmpty else { throw WatchAPIError.invalidResponse }
            if persist(WatchJournal(token: reply.token, code: reply.code)) {
                notice = ""
                nextAttempt = .distantPast
            }
        } catch {
            notice = "Connect the watch and try again."
        }
    }

    func sync() async {
        guard !busy, !storageFailed, journal.blocked.isEmpty, !journal.token.isEmpty,
              Date() >= nextAttempt else { return }
        if let first = journal.queued.first {
            await post(first)
        } else {
            await refresh(discard: false)
        }
    }

    func refresh(discard: Bool) async {
        guard !busy, !journal.token.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let card = try await api.request(WatchCard.self, path: "card", token: journal.token)
            guard !card.holes.isEmpty else { throw WatchAPIError.invalidResponse }
            let first = journal.card == nil
            var proposed = journal
            proposed.card = card
            proposed.code = ""
            if discard {
                proposed.queued = []
                proposed.blocked = ""
            }
            notice = ""
            if proposed != journal && persist(proposed) && first { goToStartingHole() }
            nextAttempt = journal.queued.isEmpty ? Date().addingTimeInterval(15) : .distantPast
        } catch {
            handle(error, posting: false)
        }
    }

    private func post(_ operation: ScoreOperation) async {
        busy = true
        defer { busy = false }
        do {
            let payload = try JSONEncoder().encode(operation)
            let receipt = try await api.request(ScoreReceipt.self, path: "score", method: "POST", token: journal.token, payload: payload)
            guard receipt.sequence == operation.sequence else { throw WatchAPIError.invalidResponse }
            var proposed = journal
            proposed.card?.acknowledge(operation)
            proposed.queued.removeFirst()
            notice = ""
            if persist(proposed) { nextAttempt = .distantPast }
        } catch {
            handle(error, posting: true)
        }
    }

    private func handle(_ error: Error, posting: Bool) {
        if Task.isCancelled { return }
        if case WatchAPIError.rejected(let status, let code) = error {
            if code == "watch_pairing_pending" {
                nextAttempt = Date().addingTimeInterval(3)
                return
            }
            if status == 429 {
                notice = "Waiting to reconnect."
                nextAttempt = Date().addingTimeInterval(60)
                return
            }
            if status < 500 {
                if journal.card == nil, status == 401, persist(WatchJournal()) {
                    notice = "Pairing expired. Request a fresh code."
                    return
                }
                var proposed = journal
                proposed.blocked = switch code {
                case "watch_score_conflict": "This score changed on the phone. Review your saved edits."
                case "watch_card_changed", "watch_round_changed", "not_on_card": "Your card changed. Check the current scores on your phone."
                case "card_locked", "not_live": "The card is closed. Review your saved edits."
                case "watch_target_changed", "no_target": "Players on this card changed. Review your saved edits."
                default: status == 401 ? "Watch access ended. Review your saved edits, then pair again." : "A saved score needs review."
                }
                persist(proposed)
                return
            }
        }
        notice = posting ? "Scores saved on this watch. Waiting to sync." : "Offline. Connect the watch to update the card."
        nextAttempt = Date().addingTimeInterval(12)
    }
}
