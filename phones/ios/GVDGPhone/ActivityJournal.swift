import Foundation

struct ActivityJournal {
    private let folder: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init() throws {
        let manager = FileManager.default
        let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var folder = support.appendingPathComponent("RoundActivity", isDirectory: true)
        try manager.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [
            .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
        ])
        var resources = URLResourceValues()
        resources.isExcludedFromBackup = true
        try folder.setResourceValues(resources)
        self.folder = folder
    }

    func current() throws -> ActivityTrack? {
        let track = try read(ActivityTrack.self, name: "active.json")
        if let track, track.stage == .stopped {
            try storeCompleted(track)
            try clearActive()
            return nil
        }
        return track
    }

    func save(_ route: ActivityTrack) throws { try write(route, name: "active.json") }
    func storeCompleted(_ route: ActivityTrack) throws { try write(route, name: route.clientId + ".json") }
    func loadCompleted(_ id: String) throws -> ActivityTrack? {
        guard UUID(uuidString: id) != nil else { throw ActivityFailure.storage }
        return try read(ActivityTrack.self, name: id + ".json")
    }
    func clearActive() throws { try FileManager.default.removeItem(at: folder.appendingPathComponent("active.json")) }

    func completed(owner: String?) throws -> [ActivityTrack] {
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        return try files.compactMap { url in
            let id = url.deletingPathExtension().lastPathComponent
            guard url.pathExtension == "json", let uuid = UUID(uuidString: id) else { return nil }
            let record = try loadCompleted(uuid.uuidString.lowercased())
            guard let record, record.ownerId == nil || record.ownerId == owner else { return nil }
            return record
        }.sorted { $0.startedAt > $1.startedAt }
    }

    func remove(_ id: String) throws {
        guard UUID(uuidString: id) != nil else { throw ActivityFailure.storage }
        try FileManager.default.removeItem(at: folder.appendingPathComponent(id + ".json"))
    }

    func settings() throws -> ActivitySettings { try read(ActivitySettings.self, name: "settings.json") ?? ActivitySettings() }
    func save(settings: ActivitySettings) throws { try write(settings, name: "settings.json") }

    private func read<T: Decodable>(_ type: T.Type, name: String) throws -> T? {
        let url = folder.appendingPathComponent(name)
        do { return try decoder.decode(type, from: Data(contentsOf: url)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    private func write<T: Encodable>(_ value: T, name: String) throws {
        try encoder.encode(value).write(to: folder.appendingPathComponent(name),
                                        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
