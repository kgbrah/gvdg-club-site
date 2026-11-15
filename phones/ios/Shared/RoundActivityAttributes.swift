import ActivityKit
import Foundation

struct RoundActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let status: String
        let basketFeet: Int?
        let expectsFix: Bool
    }

    let sessionID: UUID
}
