import CryptoKit
import Foundation
import Security

struct JournalStore {
    private let keyQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.gvdgclub.watch",
        kSecAttrAccount as String: "score-journal-key"
    ]

    private func journalURL() throws -> URL {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                    appropriateFor: nil, create: true)
        return directory.appendingPathComponent("gvdg-score-journal.v1")
    }

    func read() throws -> WatchJournal {
        let url = try journalURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return WatchJournal() }
        let sealed = try AES.GCM.SealedBox(combined: Data(contentsOf: url))
        let bytes = try AES.GCM.open(sealed, using: key(create: false))
        return try JSONDecoder().decode(WatchJournal.self, from: bytes)
    }

    func write(_ journal: WatchJournal) throws {
        let bytes = try JSONEncoder().encode(journal)
        guard let sealed = try AES.GCM.seal(bytes, using: key(create: true)).combined else { throw CocoaError(.fileWriteUnknown) }
        try sealed.write(to: journalURL(), options: .atomic)
    }

    private func key(create: Bool) throws -> SymmetricKey {
        var query = keyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound, create else { throw CocoaError(.fileReadNoPermission) }

        let fresh = SymmetricKey(size: .bits256)
        var newItem = keyQuery
        newItem[kSecValueData as String] = fresh.withUnsafeBytes { Data($0) }
        newItem[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(newItem as CFDictionary, nil) == errSecSuccess else { throw CocoaError(.fileWriteNoPermission) }
        return fresh
    }
}
