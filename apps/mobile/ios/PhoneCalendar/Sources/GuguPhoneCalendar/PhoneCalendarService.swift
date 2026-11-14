import Foundation

public struct PhoneCalendarPreparedWrite {
    public let commit: () throws -> [String: Any]
    public init(commit: @escaping () throws -> [String: Any]) { self.commit = commit }
}

public protocol PhoneCalendarStore: AnyObject {
    var authorization: PhoneCalendarAuthorization { get }
    var timezone: TimeZone { get }
    func read(start: Int64, end: Int64, limit: Int, checkpoint: @escaping () throws -> Void) throws -> [PhoneCalendarEvent]
    /// Validate calendar, target, recurrence and merged dates without committing changes.
    func prepare(_ command: PhoneCalendarCommand) throws -> PhoneCalendarPreparedWrite
}

/// Synchronous EventKit work is serialized; cancellation remains native-host state checked at boundaries.
public final class PhoneCalendarService {
    private let store: PhoneCalendarStore
    private let lock = NSLock()

    public init(store: PhoneCalendarStore) { self.store = store }

    /// The native host must call this before returning a saved receipt as well.
    public func validateAccess(_ access: PhoneCalendarAccess) throws {
        try access.check()
        guard store.authorization == .fullAccess else {
            throw PhoneCalendarFailure("os_permission", "Calendar read/write access is not granted")
        }
    }

    public func execute(method: String, arguments: [String: Any], access: PhoneCalendarAccess) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let check = { try self.validateAccess(access) }
        try check()
        let command = try PhoneCalendarCommand.parse(method: method, arguments: arguments)
        if case let .list(start, end, limit) = command {
            let events = try store.read(start: start, end: end, limit: limit, checkpoint: check)
            try check()
            return ["events": events.map(\.json), "timezone": store.timezone.identifier]
        }

        let prepared = try store.prepare(command)
        try check()
        try access.beginWrite()
        try check()
        let receipt: [String: Any]
        do {
            receipt = try prepared.commit()
            try access.finishWrite(receipt)
        } catch {
            throw PhoneCalendarFailure("execution_unknown", "Calendar write outcome is not confirmed", writeMayHaveCommitted: true)
        }
        try check()
        return receipt
    }
}
