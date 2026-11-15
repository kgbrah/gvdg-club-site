import Foundation
import Security

enum ActivityCredential {
    private static let key = "com.gvdgclub.phone.activity"
    static func read() throws -> String? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8)
        else { throw ActivityFailure.credential }
        return value
    }

    static func write(_ token: String) throws {
        guard token.range(of: "^gvdga_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { throw ActivityFailure.credential }
        let values: [String: Any] = [kSecValueData as String: Data(token.utf8)]
        let status = SecItemUpdate(base as CFDictionary, values as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw ActivityFailure.credential }
        var add = base
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { throw ActivityFailure.credential }
    }

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: key, kSecAttrAccount as String: "device"]
    }
}

final class ActivityRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct ActivityAPI {
    struct PairCode: Decodable { let code: String; let token: String; let expiresAt: Int64 }
    struct Receipt: Decodable { let id: Int; let clientId: String }

    static var website: URL {
        let host = Bundle.main.object(forInfoDictionaryKey: "GVDGSiteHost") as? String
        return URL(string: "https://" + (host == "greenvillediscgolf.com" ? "greenvillediscgolf.com" : "gvdgclub.com") + "/gvdg-members.html")!
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.httpShouldSetCookies = false
        config.urlCache = nil
        return URLSession(configuration: config, delegate: ActivityRedirects(), delegateQueue: nil)
    }()

    private static func call(_ path: String, method: String, token: String?, data: Data? = nil) async throws -> (Int, Data) {
        guard let host = website.host, let url = URL(string: "https://auth." + host + path) else { throw ActivityFailure.invalidReply }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let data {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = data
        }
        let (body, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, body.count <= 128_000 else { throw ActivityFailure.invalidReply }
        return (http.statusCode, body)
    }

    static func begin() async throws -> PairCode {
        let (status, data) = try await call("/activity/pairings", method: "POST", token: nil, data: Data("{\"platform\":\"ios\"}".utf8))
        guard (200..<300).contains(status) else { throw ActivityFailure.invalidReply }
        return try JSONDecoder().decode(PairCode.self, from: data)
    }

    static func connect(token: String) async throws -> (Int, DeviceGrant?) {
        let (status, data) = try await call("/activity/device", method: "GET", token: token)
        let grant = status == 200 ? try JSONDecoder().decode(DeviceGrant.self, from: data) : nil
        return (status, grant)
    }

    static func upload(_ track: ActivityTrack, token: String) async throws -> (Int, Receipt?) {
        let (status, data) = try await call("/activity/tracks", method: "POST", token: token, data: JSONEncoder().encode(track.upload))
        let receipt = (200..<300).contains(status) ? try JSONDecoder().decode(Receipt.self, from: data) : nil
        return (status, receipt)
    }
}
