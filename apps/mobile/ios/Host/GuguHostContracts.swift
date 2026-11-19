import Foundation

/// Every native operation is bound to one account, installation and exact task turn.
struct GuguHostContext: Codable, Equatable {
    let ownerId: String
    let installationId: String
    let agentUserId: String
    let sessionId: String
    let jobId: String
    let contextEpoch: String
    let runtimeInstanceId: String
}

/// Constructed by the native host, never accepted directly from model arguments.
struct GuguNativeToolRequest {
    let context: GuguHostContext
    let requestId: String
    let toolCallId: String
    let actionName: String
    let argumentsJSON: String
    let argumentsSHA256: String
    let deadlineAtMs: Int64
}

/// The executor must check immediately before accessing EventKit and after async waits.
/// beginMutation durably claims the exact, one-use native owner approval before an OS write.
/// A claimed write with no durable result becomes execution_unknown; it is never replayed.
final class GuguNativeToolControl {
    private let active: () throws -> Void
    private let mutation: () throws -> Void
    private let finish: ([String: Any]) throws -> Void

    init(checkActive: @escaping () throws -> Void, beginMutation: @escaping () throws -> Void,
         finishMutation: @escaping ([String: Any]) throws -> Void) {
        active = checkActive
        mutation = beginMutation
        finish = finishMutation
    }

    func checkActive() throws { try active() }
    func beginMutation() throws { try active(); try mutation() }
    /// Save the successful OS receipt data (without an ok/data envelope) before post-write checks.
    func finishMutation(_ data: [String: Any]) throws { try finish(data) }
}

protocol GuguNativeToolExecutor: AnyObject {
    /// Required before returning any saved receipt or protected task transcript.
    func validateAccess(_ control: GuguNativeToolControl) throws

    /// Complete once with the device-action envelope: ok/data or ok:false/code/message.
    /// Invocation does not request OS permission. Connection is an explicit native owner UI action.
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl,
                 completion: @escaping ([String: Any]) -> Void)
}

struct GuguHostFailure: Error {
    let code: String
    let message: String
    var envelope: [String: Any] { ["ok": false, "code": code, "message": message] }
}

/// @@@server-clock — the native host's reading of the backend's clock: the same rule as
/// packages/core/src/shared/serverClock.ts (see there). Each backend answer's `Date` (whole
/// seconds) bounds offset = server − local to [Date − received, Date + 1 s − sent]; keep the
/// intersection, start again from an answer that misses it. Compare times the backend issued
/// (model ticket expiries) with `now()`; durations and local stamps stay on `Date()`.
final class GuguServerClock {
    static let shared = GuguServerClock()
    private let lock = NSLock()
    private var low: TimeInterval = 0, high: TimeInterval = 0, known = false
    private static let httpDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss zzz"
        return formatter
    }()

    func now() -> Date {
        lock.lock(); defer { lock.unlock() }
        return Date().addingTimeInterval(known ? (low + high) / 2 : 0)
    }

    func observe(date header: String?, sentAt: Date, receivedAt: Date) {
        guard let header, let at = Self.httpDate.date(from: header), receivedAt >= sentAt else { return }
        let from = at.timeIntervalSince(receivedAt), to = at.timeIntervalSince(sentAt) + 1
        lock.lock(); defer { lock.unlock() }
        if known && from <= high && to >= low { low = max(low, from); high = min(high, to) }
        else { low = from; high = to; known = true }
    }
}
