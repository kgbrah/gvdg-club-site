import Foundation

@main
struct RouteMathChecks {
    private static let now: Int64 = 1_797_000_000_000

    static func main() throws {
        var record = ActivityTrack(owner: nil, round: nil, now: now)
        let original = fix(0, -82)
        assert(original.isFresh(at: now + 44_999))
        assert(!original.isFresh(at: now + 45_001))
        let first = try record.append(original)
        let duplicate = try record.append(fix(0, -81.9999))
        let tooSoon = try record.append(fix(5000, -81.9999))
        let valid = try record.append(fix(10_000, -81.9999))
        assert(first && !duplicate && !tooSoon && valid)
        let before = record.recordedMeters
        assert((8...10).contains(before))
        record.newSegment = true
        let resumed = try record.append(fix(20_000, -81.9998))
        let afterGap = try record.append(fix(180_000, -81))
        assert(resumed && afterGap)
        assert(record.segments.count == 3)
        assert(record.recordedMeters == before)
        record.stop(now: now + 181_000)
        let afterStop = try record.append(fix(182_000, -81))
        assert(!afterStop && record.pointCount == 4)
        assert(record.stoppedAt == now + 181_000)
        let raw = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record.upload)) as? [String: Any]
        assert(raw?["state"] == nil && raw?["serverId"] == nil && raw?["ownerId"] == nil)
        print("Swift route timeline, no-gap distance, and safe export passed")
    }

    private static func fix(_ offset: Int64, _ longitude: Double) -> GPSPoint {
        GPSPoint(at: now + offset, lat: 35, lng: longitude, accuracyM: 6)
    }
}
