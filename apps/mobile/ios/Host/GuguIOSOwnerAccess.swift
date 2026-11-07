import Foundation

struct GuguIOSOwnerSnapshot {
    let binding: GuguIOSHostBinding
    let calendarConnected: Bool
    let calendarRevision: String?
}

struct GuguIOSCalendarConnection {
    let binding: GuguIOSHostBinding
    let attemptId: String
}

/// Identity comes from A's verified shared-login publication, never configure or
/// tool arguments. This store owns only the local calendar category selection.
final class GuguIOSOwnerAccess {
    private let root: URL
    private let verifiedIdentity: () throws -> GuguIOSHostBinding
    private let requireOwnerUI: () throws -> Void
    private let calendarHasFullAccess: () -> Bool
    private let revokeCalendarAccess: () throws -> Void

    init(root: URL, verifiedIdentity: @escaping () throws -> GuguIOSHostBinding,
         requireOwnerUI: @escaping () throws -> Void, calendarHasFullAccess: @escaping () -> Bool,
         revokeCalendarAccess: @escaping () throws -> Void) {
        self.root = root; self.verifiedIdentity = verifiedIdentity; self.requireOwnerUI = requireOwnerUI
        self.calendarHasFullAccess = calendarHasFullAccess; self.revokeCalendarAccess = revokeCalendarAccess
    }

    func ownerSnapshot() throws -> GuguIOSOwnerSnapshot {
        let binding = try currentBinding()
        return try transaction(binding) { path in
            let saved = try load(path, binding)
            return GuguIOSOwnerSnapshot(binding: binding, calendarConnected: saved["connected"] as? Bool == true,
                                        calendarRevision: saved["revision"] as? String)
        }
    }

    func calendarEnabled() throws -> Bool { try ownerSnapshot().calendarConnected }

    func requireLocalOwnerUI() throws {
        let binding = try currentBinding()
        try requireOwnerUI()
        guard try currentBinding() == binding else { throw Self.failure("stale_context", "Owner changed during local UI authorization") }
    }

    /// Call before C's asynchronous OS permission request, including reconnects.
    /// A denied request remains disconnected and cannot revive old task epochs.
    func beginCalendarConnection(expectedBinding binding: GuguIOSHostBinding) throws -> GuguIOSCalendarConnection {
        try requireLocalOwnerUI()
        return try transaction(binding) { path in
            _ = try load(path, binding)
            try revokeCalendarAccess()
            let attempt = GuguIOSCalendarConnection(binding: binding, attemptId: UUID().uuidString.lowercased())
            try save(path, binding, connected: false, revision: attempt.attemptId)
            return attempt
        }
    }

    func finishCalendarConnection(attempt: GuguIOSCalendarConnection) throws -> GuguIOSOwnerSnapshot {
        try requireLocalOwnerUI()
        try transaction(attempt.binding) { path in
            let saved = try load(path, attempt.binding)
            guard saved["revision"] as? String == attempt.attemptId, saved["connected"] as? Bool == false else {
                throw Self.failure("stale_context", "Calendar connection attempt was replaced or already consumed")
            }
            guard calendarHasFullAccess() else { throw Self.failure("os_permission", "Full calendar access is required") }
            try save(path, attempt.binding, connected: true, revision: attempt.attemptId)
        }
        return try ownerSnapshot()
    }

    @discardableResult func disconnectCalendar(expectedBinding binding: GuguIOSHostBinding) throws -> GuguIOSOwnerSnapshot {
        _ = try beginCalendarConnection(expectedBinding: binding)
        return try ownerSnapshot()
    }

    private func currentBinding() throws -> GuguIOSHostBinding {
        let binding = try verifiedIdentity()
        try binding.validate()
        return binding
    }

    private func transaction<T>(_ binding: GuguIOSHostBinding, _ body: (URL) throws -> T) throws -> T {
        guard try currentBinding() == binding else { throw Self.failure("stale_context", "Native owner or installation changed") }
        let directory = root.appendingPathComponent(binding.ownerId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var protected = directory, values = URLResourceValues(); values.isExcludedFromBackup = true
        try protected.setResourceValues(values)
        let path = directory.appendingPathComponent("calendar-connection.json")
        let lock = GuguJournalFileLock(url: path)
        try lock.lock(); defer { lock.unlock() }
        guard try currentBinding() == binding else { throw Self.failure("stale_context", "Native owner or installation changed") }
        let result = try body(path)
        guard try currentBinding() == binding else { throw Self.failure("stale_context", "Native owner or installation changed") }
        return result
    }

    private func load(_ path: URL, _ binding: GuguIOSHostBinding) throws -> [String: Any] {
        if !FileManager.default.fileExists(atPath: path.path) { return ["connected": false] }
        guard let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any],
              saved["version"] as? Int == 1, saved["ownerId"] as? String == binding.ownerId,
              saved["deviceId"] as? String == binding.deviceId, saved["installationId"] as? String == binding.installationId,
              saved["connected"] is Bool else { throw Self.failure("stale_context", "Calendar category identity or version mismatch") }
        return saved
    }

    private func save(_ path: URL, _ binding: GuguIOSHostBinding, connected: Bool, revision: String) throws {
        guard try currentBinding() == binding else { throw Self.failure("stale_context", "Native owner or installation changed") }
        let saved: [String: Any] = ["version": 1, "ownerId": binding.ownerId, "deviceId": binding.deviceId,
            "installationId": binding.installationId, "connected": connected, "revision": revision]
        let data = try JSONSerialization.data(withJSONObject: saved, options: [.sortedKeys])
        #if os(iOS)
        try data.write(to: path, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: path, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let file = try FileHandle(forWritingTo: path); try file.synchronize(); try file.close()
    }

    private static func failure(_ code: String, _ message: String) -> GuguHostFailure { GuguHostFailure(code: code, message: message) }
}
