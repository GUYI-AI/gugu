import Foundation
import CryptoKit

/// Shared Android namespace: SHA-256 of JSON.stringify(parts), with the same
/// UUID nibble substitutions. IDs are never regenerated when a reply is lost.
enum GuguIOSStableID {
    static func strings(_ parts: String...) throws -> String { try values(parts) }
    static func values(_ parts: [Any]) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: parts, options: [.withoutEscapingSlashes])
        let hex = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let chars = Array(hex)
        func slice(_ from: Int, _ to: Int) -> String { String(chars[from..<to]) }
        return "\(slice(0, 8))-\(slice(8, 12))-5\(slice(13, 16))-a\(slice(17, 20))-\(slice(20, 32))"
    }
}

/// Native provision/input/outbox custody, separate from the Pi event journal.
/// Reads reload under the same stable sidecar lock as updates. Initialization
/// performs no execution, cloud call or automatic replay of uncertain work.
final class GuguIOSBackendStore {
    let binding: GuguIOSHostBinding
    private let path: URL
    private let lock: GuguJournalFileLock
    var custodyKey: String { path.resolvingSymlinksInPath().standardizedFileURL.path }
    init(root: URL, binding: GuguIOSHostBinding) throws {
        try binding.validate(); self.binding = binding
        var directory = root.appendingPathComponent(binding.ownerId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory.setResourceValues(values)
        path = directory.appendingPathComponent("backend.json"); lock = GuguJournalFileLock(url: path)
        try lock.lock(); defer { lock.unlock() }
        if FileManager.default.fileExists(atPath: path.path) { _ = try load() }
        else { try save(["version": 1, "ownerId": binding.ownerId, "deviceId": binding.deviceId, "installationId": binding.installationId,
            "requests": [String: Any](), "agents": [String: Any](), "inputs": [String: Any](), "leases": [String: Any](), "outbox": [String: Any]()]) }
    }
    func snapshot() throws -> [String: Any] {
        try lock.lock(); defer { lock.unlock() }; return try load()
    }
    @discardableResult func transaction<T>(_ work: (inout [String: Any]) throws -> T) throws -> T {
        try lock.lock(); defer { lock.unlock() }
        var next = try load(); let value = try work(&next); try save(next); return value
    }
    func record(_ collection: String, id: String) throws -> [String: Any]? {
        try collectionAllowed(collection)
        return (try snapshot()[collection] as? [String: [String: Any]])?[id]
    }
    @discardableResult func admit(_ collection: String, id: String, fingerprint: String,
                                 create: () throws -> [String: Any]) throws -> [String: Any] {
        try collectionAllowed(collection)
        return try transaction { state in
            var rows = state[collection] as? [String: [String: Any]] ?? [:]
            if let existing = rows[id] {
                guard existing["fingerprint"] as? String == fingerprint else { throw Self.failure("duplicate_conflict", "Original request has different input") }
                return existing
            }
            var value = try create(); value["fingerprint"] = fingerprint
            rows[id] = value; state[collection] = rows; return value
        }
    }
    func update(_ collection: String, id: String, _ work: (inout [String: Any]) throws -> Void) throws {
        try collectionAllowed(collection)
        try transaction { state in
            var rows = state[collection] as? [String: [String: Any]] ?? [:]
            guard var value = rows[id] else { throw Self.failure("record_unreadable", "Durable operation does not exist") }
            try work(&value); rows[id] = value; state[collection] = rows
        }
    }
    private func collectionAllowed(_ name: String) throws {
        guard ["requests", "agents", "inputs", "leases", "outbox"].contains(name) else { throw Self.failure("invalid_args", "Unknown native record collection") }
    }
    private func load() throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any],
              object["version"] as? Int == 1, object["ownerId"] as? String == binding.ownerId,
              object["installationId"] as? String == binding.installationId, object["deviceId"] as? String == binding.deviceId,
              ["requests", "agents", "inputs", "leases", "outbox"].allSatisfy({ object[$0] is [String: Any] }) else {
            throw Self.failure("stale_context", "Native backend record identity or version differs")
        }
        try GuguIOSCloudBroker.rejectCredentials(object)
        return object
    }
    private func save(_ object: [String: Any]) throws {
        guard object["version"] as? Int == 1, object["ownerId"] as? String == binding.ownerId,
              object["installationId"] as? String == binding.installationId, object["deviceId"] as? String == binding.deviceId,
              ["requests", "agents", "inputs", "leases", "outbox"].allSatisfy({ object[$0] is [String: Any] }) else {
            throw Self.failure("stale_context", "Native backend update changed record custody")
        }
        try GuguIOSCloudBroker.rejectCredentials(object)
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        #if os(iOS)
        try data.write(to: path, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: path, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let file = try FileHandle(forWritingTo: path); try file.synchronize(); try file.close()
    }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { GuguHostFailure(code: code, message: text) }
}
