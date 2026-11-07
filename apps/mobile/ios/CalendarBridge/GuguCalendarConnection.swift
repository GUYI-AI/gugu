import Foundation

/// The local owner transaction spans the asynchronous OS permission request.
/// The one-use native attempt is never returned to the renderer.
final class GuguCalendarConnection {
    typealias RequestAccess = (@escaping () throws -> Void, @escaping (Result<Void, Error>) -> Void) -> Void
    private let ownerAccess: GuguIOSOwnerAccess
    private let hasFullAccess: () -> Bool
    private let requestAccess: RequestAccess

    init(ownerAccess: GuguIOSOwnerAccess, hasFullAccess: @escaping () -> Bool,
         requestAccess: @escaping RequestAccess) {
        self.ownerAccess = ownerAccess
        self.hasFullAccess = hasFullAccess
        self.requestAccess = requestAccess
    }

    func snapshot(ownerId: String) throws -> GuguIOSOwnerSnapshot {
        try ownerAccess.requireLocalOwnerUI()
        var snapshot = try ownerAccess.ownerSnapshot()
        guard snapshot.binding.ownerId == ownerId else { throw stale() }
        if snapshot.calendarConnected && !hasFullAccess() {
            snapshot = try ownerAccess.disconnectCalendar(expectedBinding: snapshot.binding)
        }
        return snapshot
    }

    func connect(expectedBinding: GuguIOSHostBinding, completion: @escaping (Result<GuguIOSOwnerSnapshot, Error>) -> Void) {
        do {
            try check(expectedBinding)
            let attempt = try ownerAccess.beginCalendarConnection(expectedBinding: expectedBinding)
            requestAccess({ try self.check(expectedBinding) }) { result in
                do {
                    try result.get()
                    // finish rechecks the current identity, foreground UI, attempt and full access.
                    completion(.success(try self.ownerAccess.finishCalendarConnection(attempt: attempt)))
                } catch { completion(.failure(error)) }
            }
        } catch { completion(.failure(error)) }
    }

    func disconnect(expectedBinding: GuguIOSHostBinding) throws -> GuguIOSOwnerSnapshot {
        try check(expectedBinding)
        return try ownerAccess.disconnectCalendar(expectedBinding: expectedBinding)
    }

    private func check(_ binding: GuguIOSHostBinding) throws {
        try ownerAccess.requireLocalOwnerUI()
        guard try ownerAccess.ownerSnapshot().binding == binding else { throw stale() }
    }

    private func stale() -> GuguHostFailure {
        GuguHostFailure(code: "stale_context", message: "Native owner or installation changed")
    }
}
