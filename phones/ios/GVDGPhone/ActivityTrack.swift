import Foundation

struct GPSPoint: Codable {
    let at: Int64
    let lat: Double
    let lng: Double
    let accuracyM: Double

    var valid: Bool {
        lat.isFinite && abs(lat) <= 90 && lng.isFinite && abs(lng) <= 180 &&
            accuracyM.isFinite && (0...50).contains(accuracyM)
    }

    func isFresh(at now: Int64) -> Bool { valid && at >= now - 45_000 && at <= now + 2_000 }
}

struct RoundBinding: Codable, Equatable {
    let key: String
    let generation: String
}

struct PairedRound: Codable {
    struct Coordinate: Codable { let lat: Double; let lng: Double }
    struct Hole: Codable, Identifiable {
        let hole: Int
        let basket: Coordinate?
        var id: Int { hole }
    }

    let key: String
    let generation: String
    let status: String
    let courseName: String?
    let layoutName: String?
    let startingHole: Int?
    let holes: [Hole]

    var binding: RoundBinding? { status == "live" ? RoundBinding(key: key, generation: generation) : nil }
}

struct DeviceGrant: Codable {
    let deviceId: String
    let memberId: String
    var expiresAt: Int64
    var round: PairedRound?
    let roundUnavailable: Bool
}

struct ActivitySettings: Codable {
    var device: DeviceGrant?
    var code: String?
    var codeExpiresAt: Int64?
    var hole: Int?
    var lockDistance = false

    func basket(at now: Int64) -> PairedRound.Coordinate? {
        guard let device, device.expiresAt > now, let round = device.round, round.status == "live" else { return nil }
        let number = hole ?? round.startingHole ?? round.holes.first?.hole
        return round.holes.first(where: { $0.hole == number })?.basket
    }
}

struct ActivityTrack: Codable, Identifiable {
    enum Stage: String, Codable { case tracking, paused, stopped }
    static let maxTime: Int64 = 86_400_000
    static let maxGap: Int64 = 90_000
    static let maxPoints = 4096

    let version: Int
    let clientId: String
    var ownerId: String?
    let startedAt: Int64
    var stoppedAt: Int64?
    let round: RoundBinding?
    var segments: [[GPSPoint]]
    var stage: Stage
    var newSegment: Bool
    var serverId: Int?

    var id: String { clientId }
    var pointCount: Int { segments.reduce(0) { $0 + $1.count } }

    init(owner: String?, round: RoundBinding?, now: Int64) {
        version = 1
        clientId = UUID().uuidString.lowercased()
        ownerId = owner
        startedAt = now
        self.round = round
        segments = []
        stage = .tracking
        newSegment = true
    }

    var recordedMeters: Int {
        var total = 0.0
        for segment in segments {
            for (a, b) in zip(segment, segment.dropFirst()) {
                let elapsed = b.at - a.at
                guard elapsed > 0 && elapsed <= Self.maxGap else { continue }
                let length = Self.distance(a.lat, a.lng, b.lat, b.lng)
                let threshold = max(5, min(20, max(a.accuracyM, b.accuracyM) / 2))
                if length >= threshold && length <= 15 * Double(elapsed) / 1000 { total += length }
            }
        }
        return Int(total.rounded())
    }

    mutating func append(_ sample: GPSPoint) throws -> Bool {
        guard stage == .tracking, sample.at >= startedAt else { return false }
        guard sample.at < startedAt + Self.maxTime, pointCount < Self.maxPoints else { throw ActivityFailure.limit }
        guard let previous = segments.last?.last else {
            segments.append([sample])
            newSegment = false
            return true
        }
        let elapsed = sample.at - previous.at
        if elapsed <= 0 { return false }
        if newSegment || elapsed > Self.maxGap {
            segments.append([sample])
        } else {
            if elapsed < 10_000 { return false }
            segments[segments.count - 1].append(sample)
        }
        newSegment = false
        return true
    }

    mutating func stop(now: Int64) {
        let end = min(max(startedAt, now), startedAt + Self.maxTime)
        stoppedAt = max(end, segments.last?.last?.at ?? end)
        stage = .stopped
    }

    struct Upload: Encodable {
        let version: Int
        let clientId: String
        let ownerId: String?
        let startedAt: Int64
        let stoppedAt: Int64?
        let round: RoundBinding?
        let segments: [[GPSPoint]]
    }

    var upload: Upload { Upload(version: version, clientId: clientId, ownerId: ownerId, startedAt: startedAt,
                                stoppedAt: stoppedAt, round: round, segments: segments) }

    static func distance(_ aLat: Double, _ aLng: Double, _ bLat: Double, _ bLng: Double) -> Double {
        let r = Double.pi / 180
        let x = sin((bLat - aLat) * r / 2)
        let y = sin((bLng - aLng) * r / 2)
        let h = x * x + cos(aLat * r) * cos(bLat * r) * y * y
        return 12_742_000 * asin(sqrt(max(0, min(1, h))))
    }
}

enum ActivityFailure: Error { case limit, storage, invalidReply, credential, ownership }

enum WallClock {
    static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
