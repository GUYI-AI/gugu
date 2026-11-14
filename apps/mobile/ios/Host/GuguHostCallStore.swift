import Foundation

/// Persistent custody of the original native host-call UUID. This does not replace
/// the provisioning/input saga: uncertain calls require backend reconciliation.
final class GuguHostCallStore {
    private let lock: GuguJournalFileLock
    private let binding: GuguIOSHostBinding
    private let path: URL
    private var calls: [String: [String: Any]]

    init(root: URL, binding: GuguIOSHostBinding) throws {
        self.binding = binding
        try binding.validate()
        let directory = root.appendingPathComponent(binding.ownerId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var protected = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try protected.setResourceValues(values)
        path = directory.appendingPathComponent("host-calls.json")
        lock = GuguJournalFileLock(url: path)
        calls = [:]
        try lock.lock(); defer { lock.unlock() }
        if FileManager.default.fileExists(atPath: path.path) { calls = try load() }
        var recovered = calls
        for (id, var call) in recovered where call["status"] as? String == "executing" {
            call["status"] = "uncertain"
            recovered[id] = call
        }
        try save(recovered)
    }

    func admit(_ call: GuguIOSHostInvocation) throws -> [String: Any] {
        try lock.lock(); defer { lock.unlock() }
        calls = try load()
        let fingerprint = try fingerprint(call)
        if let prior = calls[call.requestId] {
            guard prior["fingerprint"] as? String == fingerprint else {
                throw GuguHostFailure(code: "duplicate_conflict", message: "Host-call UUID has different channel, input or origin")
            }
            return prior
        }
        let record: [String: Any] = ["requestId": call.requestId, "channel": call.channel, "args": call.arguments,
                                    "origin": call.origin == .localOwnerUI ? "local-owner-ui" : "remote-agent", "fingerprint": fingerprint, "status": "admitted"]
        var next = calls; next[call.requestId] = record
        try save(next)
        return record
    }

    func begin(_ call: GuguIOSHostInvocation) throws {
        try update(call) { record in
            guard record["status"] as? String == "admitted" else {
                throw GuguHostFailure(code: "admission_uncertain", message: "Host call requires reconciliation")
            }
            record["status"] = "executing"
        }
    }

    func finish(_ call: GuguIOSHostInvocation, reply: [String: Any]) throws {
        try update(call) { record in
            let hasResult = reply.keys.contains("result"), hasError = reply["error"] is [String: Any]
            guard hasResult != hasError else { throw GuguHostFailure(code: "invalid_backend_reply", message: "Host backend reply must contain result or error") }
            if record["status"] as? String == "completed" {
                guard let saved = record["reply"] as? [String: Any], try GuguHostJournal.digest(saved) == GuguHostJournal.digest(reply) else {
                    throw GuguHostFailure(code: "duplicate_conflict", message: "A terminal host receipt cannot be overwritten")
                }
                return
            }
            if let error = reply["error"] as? [String: Any], error["admission"] as? String != "rejected" {
                record["status"] = "uncertain"
                record["lastError"] = error
            } else {
                record["status"] = "completed"
                record["reply"] = reply
                record.removeValue(forKey: "lastError")
            }
        }
    }

    private func update(_ call: GuguIOSHostInvocation, _ work: (inout [String: Any]) throws -> Void) throws {
        try lock.lock(); defer { lock.unlock() }
        calls = try load()
        let id = call.requestId
        guard var record = calls[id] else { throw GuguHostFailure(code: "invalid_args", message: "Unknown host-call UUID") }
        guard try record["fingerprint"] as? String == fingerprint(call) else {
            throw GuguHostFailure(code: "duplicate_conflict", message: "Host receipt does not match admitted input")
        }
        try work(&record)
        var next = calls; next[id] = record
        try save(next)
    }

    private func fingerprint(_ call: GuguIOSHostInvocation) throws -> String {
        guard call.binding == binding, UUID(uuidString: call.requestId) != nil else {
            throw GuguHostFailure(code: "stale_context", message: "Host-call identity mismatch")
        }
        return try GuguHostJournal.digest(["channel": call.channel, "args": call.arguments,
            "origin": call.origin == .localOwnerUI ? "local-owner-ui" : "remote-agent"])
    }

    private func load() throws -> [String: [String: Any]] {
        guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any],
              object["version"] as? Int == 1, object["ownerId"] as? String == binding.ownerId,
              object["deviceId"] as? String == binding.deviceId, object["installationId"] as? String == binding.installationId,
              let records = object["calls"] as? [String: [String: Any]] else {
            throw GuguHostFailure(code: "stale_context", message: "Host-call journal identity mismatch")
        }
        return records
    }

    private func save(_ records: [String: [String: Any]]) throws {
        let object: [String: Any] = ["version": 1, "ownerId": binding.ownerId, "deviceId": binding.deviceId,
                                     "installationId": binding.installationId, "calls": records]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        #if os(iOS)
        try data.write(to: path, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: path, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let file = try FileHandle(forWritingTo: path)
        try file.synchronize(); try file.close()
        calls = records
    }
}
