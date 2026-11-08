import Foundation

/// App-owned custody shared by the calendar connection and task backend. Creating
/// another facade for the same canonical root does not reopen/recover a live journal.
/// Native callers supply verified bindings; there is no renderer/model entry point.
final class GuguIOSHostLifecycle {
    private enum Phase { case active, stopping, stopped, stopFailed }
    private final class Entry {
        let binding: GuguIOSHostBinding
        let journal: GuguHostJournal
        var phase: Phase = .active
        var hosts: [String: GuguInProcessHost] = [:]
        // Keep late known OS receipts attached to their original host/journal.
        var retiredHosts: [GuguInProcessHost] = []
        init(binding: GuguIOSHostBinding, journal: GuguHostJournal) {
            self.binding = binding; self.journal = journal
        }
    }
    private final class Root {
        let lock = NSRecursiveLock()
        var entries: [String: Entry] = [:]
    }
    private static let rootsLock = NSLock()
    private static var roots: [String: Root] = [:]
    private let root: URL
    private let custody: Root
    private let verifiedIdentity: () throws -> GuguIOSHostBinding

    init(root: URL, verifiedIdentity: @escaping () throws -> GuguIOSHostBinding) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        self.verifiedIdentity = verifiedIdentity
        Self.rootsLock.lock(); defer { Self.rootsLock.unlock() }
        if let existing = Self.roots[self.root.path] { custody = existing }
        else {
            let created = Root(); Self.roots[self.root.path] = created; custody = created
        }
    }

    func journal(binding: GuguIOSHostBinding) throws -> GuguHostJournal {
        try check(binding)
        custody.lock.lock(); defer { custody.lock.unlock() }
        try check(binding)
        return try entry(binding).journal
    }

    /// Explicit configure after a successful retirement. Never resumes any task.
    func activate(binding: GuguIOSHostBinding) throws {
        try check(binding)
        custody.lock.lock(); defer { custody.lock.unlock() }
        try check(binding)
        let value = try entry(binding)
        switch value.phase {
        case .active: return
        case .stopped:
            value.retiredHosts.append(contentsOf: value.hosts.values)
            value.hosts.removeAll(); value.phase = .active
        case .stopping, .stopFailed:
            throw Self.failure("host_stopping", "Native owner retirement must finish before configuring another host")
        }
    }

    /// nativeKey belongs to the native task registry, never to model arguments.
    /// The factory must use this journal and must not start a task while constructing.
    func host(binding: GuguIOSHostBinding, nativeKey: String,
              create: (GuguHostJournal) throws -> GuguInProcessHost) throws -> GuguInProcessHost {
        try check(binding)
        guard UUID(uuidString: nativeKey) != nil else { throw Self.failure("invalid_args", "Native host key must be a UUID") }
        custody.lock.lock(); defer { custody.lock.unlock() }
        try check(binding)
        let value = try entry(binding)
        guard value.phase == .active else { throw Self.failure("host_stopping", "Native owner is retired or stopping") }
        if let existing = value.hosts[nativeKey] { return existing }
        let created = try create(value.journal)
        value.hosts[nativeKey] = created
        return created
    }

    /// Opens the real disk journal even when no model/JSC host has ever existed.
    /// Persist revocation once, then notify every already-created runtime.
    /// binding is the caller's expected transaction identity, never a new lookup.
    func revokeCalendarAccess(binding: GuguIOSHostBinding) throws {
        try check(binding)
        custody.lock.lock()
        let journal: GuguHostJournal
        let hosts: [GuguInProcessHost]
        do {
            try check(binding)
            let value = try entry(binding)
            journal = value.journal; hosts = Array(value.hosts.values)
        } catch { custody.lock.unlock(); throw error }
        custody.lock.unlock()
        let affected = try journal.invalidateCalendarContexts()
        var firstError: Error?
        for host in hosts {
            do { try host.calendarContextsRevoked(affected) }
            catch { if firstError == nil { firstError = error } }
        }
        if let firstError { throw firstError }
    }

    /// Publication is already sealed by OwnerSession, so retirement intentionally
    /// does not consult current credentials. All registered hosts for this owner
    /// are attempted even if another journal/runtime fails to stop.
    func stop(ownerId: String) throws {
        guard UUID(uuidString: ownerId) != nil else { throw Self.failure("invalid_args", "Invalid native owner") }
        try stopEntries { $0.binding.ownerId == ownerId }
    }
    /// Cleanup already owns a sealed original binding; no current publication is
    /// required and another account/installation's native hosts are untouched.
    func stop(binding: GuguIOSHostBinding) throws {
        try binding.validate(); try stopEntries { $0.binding == binding }
    }
    private func stopEntries(_ matches: (Entry) -> Bool) throws {
        custody.lock.lock()
        let values = custody.entries.values.filter { matches($0) && $0.phase != .stopped }
        if values.contains(where: { $0.phase == .stopping }) {
            custody.lock.unlock(); throw Self.failure("host_stopping", "Native owner retirement is already in progress")
        }
        for value in values { value.phase = .stopping }
        let snapshots = values.map { ($0, Array($0.hosts.values)) }
        custody.lock.unlock()
        var firstError: Error?
        for (value, hosts) in snapshots {
            var failure: Error?
            do { try value.journal.cancelAllTasks() }
            catch { failure = error }
            for host in hosts {
                do { try host.stop() }
                catch { if failure == nil { failure = error } }
            }
            custody.lock.lock()
            value.phase = failure == nil ? .stopped : .stopFailed
            custody.lock.unlock()
            if firstError == nil { firstError = failure }
        }
        if let firstError { throw firstError }
    }

    /// Fits OwnerSession's zero-argument stopNative barrier after it seals
    /// publication. Do not try to obtain a now-retired binding inside that hook.
    func stopAll() throws {
        custody.lock.lock()
        let owners = Set(custody.entries.values.map { $0.binding.ownerId })
        custody.lock.unlock()
        var firstError: Error?
        for owner in owners {
            do { try stop(ownerId: owner) }
            catch { if firstError == nil { firstError = error } }
        }
        if let firstError { throw firstError }
    }

    private func entry(_ binding: GuguIOSHostBinding) throws -> Entry {
        let key = "\(binding.ownerId):\(binding.installationId)"
        if let existing = custody.entries[key] { return existing }
        let created = Entry(binding: binding, journal: try GuguHostJournal(root: root,
            ownerId: binding.ownerId, installationId: binding.installationId))
        custody.entries[key] = created
        return created
    }
    private func check(_ binding: GuguIOSHostBinding) throws {
        try binding.validate()
        guard try verifiedIdentity() == binding else { throw Self.failure("stale_context", "Native owner or installation changed") }
    }
    private static func failure(_ code: String, _ message: String) -> GuguHostFailure {
        GuguHostFailure(code: code, message: message)
    }
}
