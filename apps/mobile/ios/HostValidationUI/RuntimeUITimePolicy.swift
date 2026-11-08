import Foundation

/// Shared by the actual Simulator UI driver and the offline CLT policy probes.
/// This admits an action start; it does not bound the duration of an OS UI API.
enum RuntimeUITimePolicy {
    enum Rejected: Error, Equatable { case invalidDuration, expired, staleLease }

    static func checkLease(now: Double, hardStop: Double, verifiedAt: Double) throws {
        guard now.isFinite, hardStop.isFinite, verifiedAt.isFinite,
              now < hardStop else { throw Rejected.expired }
        guard verifiedAt <= now, now - verifiedAt < 8 else { throw Rejected.staleLease }
    }

    static func perform(issuedAt: Double, deadline: Double, hardStop: Double,
                        readVerifiedState: () throws -> Double,
                        clock: () -> Double = { Date().timeIntervalSince1970 },
                        action: () throws -> Void) throws {
        // All filesystem reads, hashes and identity/barrier validation happen here first.
        let verifiedAt = try readVerifiedState()
        // One final clock sample, then only scalar validation before the actual UI closure.
        let now = clock()
        guard issuedAt.isFinite, deadline.isFinite,
              deadline > issuedAt, deadline - issuedAt <= 20,
              deadline <= hardStop else { throw Rejected.invalidDuration }
        try checkLease(now: now, hardStop: hardStop, verifiedAt: verifiedAt)
        guard issuedAt <= now, now < deadline else { throw Rejected.expired }
        try action()
    }
}
