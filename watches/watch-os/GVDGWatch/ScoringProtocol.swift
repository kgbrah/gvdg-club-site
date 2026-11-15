import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct WatchCard: Codable, Equatable {
    struct Basket: Codable, Equatable {
        let lat: Double
        let lng: Double
    }

    struct Hole: Codable, Equatable, Identifiable {
        let hole: Int
        let par: Int
        let distanceFt: Double?
        let basket: Basket?
        var id: Int { hole }
    }

    struct Target: Codable, Equatable, Identifiable {
        let id: String
        let binding: String
        let name: String
        var votes: [String: Int]
        let scores: [String: Int]
        let conflicts: [Int]
    }

    let courseName: String?
    let startingHole: Int?
    let locked: Bool
    let scoringStyle: String
    let expiresAt: Int64
    let holes: [Hole]
    var targets: [Target]
    var lastSequence: Int64

    var putting: Bool { scoringStyle == "putting" }

    mutating func acknowledge(_ operation: ScoreOperation) {
        lastSequence = operation.sequence
        if let targetIndex = targets.firstIndex(where: { $0.id == operation.targetId && $0.binding == operation.binding }) {
            targets[targetIndex].votes[String(operation.hole)] = operation.strokes
        }
    }
}

struct ScoreOperation: Codable, Equatable, Identifiable {
    let sequence: Int64
    let targetId: String
    let binding: String
    let hole: Int
    let previous: Int?
    let strokes: Int?
    var id: Int64 { sequence }

    enum CodingKeys: String, CodingKey { case sequence, targetId, binding, hole, previous, strokes }

    func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(sequence, forKey: .sequence)
        try fields.encode(targetId, forKey: .targetId)
        try fields.encode(binding, forKey: .binding)
        try fields.encode(hole, forKey: .hole)
        try fields.encode(previous, forKey: .previous)
        try fields.encode(strokes, forKey: .strokes)
    }
}

struct WatchJournal: Codable, Equatable {
    var token = ""
    var code = ""
    var card: WatchCard?
    var queued: [ScoreOperation] = []
    var blocked = ""

    func displayedVote(for target: WatchCard.Target, hole: Int) -> Int? {
        if let pending = queued.last(where: { $0.targetId == target.id && $0.binding == target.binding && $0.hole == hole }) {
            return pending.strokes
        }
        return target.votes[String(hole)]
    }

    mutating func append(target: WatchCard.Target, hole: Int, strokes: Int?) {
        let previous = displayedVote(for: target, hole: hole)
        guard previous != strokes else { return }
        let next = (queued.last?.sequence ?? card?.lastSequence ?? 0) + 1
        queued.append(ScoreOperation(sequence: next, targetId: target.id, binding: target.binding,
                                     hole: hole, previous: previous, strokes: strokes))
    }
}

struct PairingReply: Decodable {
    let token: String
    let code: String
}

struct ScoreReceipt: Decodable {
    let sequence: Int64
}

enum WatchAPIError: Error {
    case rejected(status: Int, code: String)
    case invalidResponse
}

final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct WatchAPI {
    #if GVDG_PRODUCTION
    static let phoneSite = "greenvillediscgolf.com"
    #else
    static let phoneSite = "gvdgclub.com"
    #endif

    private let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)

    func request<Reply: Decodable>(_ type: Reply.Type, path: String, method: String = "GET", token: String = "",
                                   payload: Data? = nil) async throws -> Reply {
        guard let url = URL(string: "https://auth.\(Self.phoneSite)/watch/\(path)") else { throw WatchAPIError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 9)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let payload {
            request.httpBody = payload
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, data.count <= 512_000 else { throw WatchAPIError.invalidResponse }
        guard (200...299).contains(http.statusCode) else {
            throw WatchAPIError.rejected(status: http.statusCode, code: errorCode(data))
        }
        return try JSONDecoder().decode(type, from: data)
    }

    private func errorCode(_ data: Data) -> String {
        (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? ""
    }
}
