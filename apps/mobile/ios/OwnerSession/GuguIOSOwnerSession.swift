import Foundation

/// A projection of the existing Keychain record. The refresh token is never read.
struct GuguIOSStoredSession {
    let ownerId: String
    let accessToken: String
    let expiresAt: Date
}

/// Native memory only. Never serialize this value into a task, journal or bridge result.
struct GuguIOSOwnerCredentials: CustomDebugStringConvertible {
    let binding: GuguIOSHostBinding
    let accessToken: String
    let expiresAt: Date
    var debugDescription: String { "GuguIOSOwnerCredentials(<redacted>)" }
}

/// The renderer's sessionCoordinator remains the sole refresh authority. Publishing
/// here verifies one already-committed access token; it cannot create or refresh it.
final class GuguIOSOwnerSession {
    typealias Verify = (String, @escaping (Result<String, Error>) -> Void) -> Void
    typealias Stop = (@escaping (Result<Void, Error>) -> Void) -> Void
    private let lock = NSRecursiveLock()
    private let readStored: () throws -> GuguIOSStoredSession?
    private let installationId: () throws -> String
    private let verifyUser: Verify
    private let stopNative: Stop
    private let now: () -> Date
    private var generation: UInt64 = 0
    private var active: GuguIOSOwnerCredentials?
    private var retiring = false

    init(readStored: @escaping () throws -> GuguIOSStoredSession?, installationId: @escaping () throws -> String,
         verifyUser: @escaping Verify, stopNative: @escaping Stop, now: @escaping () -> Date = Date.init) {
        self.readStored = readStored; self.installationId = installationId
        self.verifyUser = verifyUser; self.stopNative = stopNative; self.now = now
    }

    func publish(ownerId: String, accessToken: String,
                 completion: @escaping (Result<GuguIOSHostBinding, Error>) -> Void) {
        do {
            lock.lock()
            let stored: GuguIOSStoredSession
            do {
                guard !retiring else { throw Self.failure("host_not_ready", "Native retirement must finish before publication") }
                stored = try matchingStored(ownerId: ownerId, accessToken: accessToken)
                generation &+= 1
                if active?.binding.ownerId != ownerId { active = nil }
            } catch { lock.unlock(); throw error }
            let issued = generation
            lock.unlock()
            verifyUser(stored.accessToken) { result in
                self.lock.lock()
                let outcome: Result<GuguIOSHostBinding, Error>
                do {
                    guard self.generation == issued && !self.retiring else { throw Self.stale() }
                    let verifiedOwner = try result.get()
                    guard verifiedOwner == ownerId else { throw Self.failure("auth_identity_mismatch", "Verified user differs from the committed owner") }
                    let current = try self.matchingStored(ownerId: ownerId, accessToken: accessToken)
                    let install = try self.installationId()
                    let binding = GuguIOSHostBinding(ownerId: ownerId, deviceId: "phone-\(install)-\(ownerId)", installationId: install)
                    try binding.validate()
                    self.active = GuguIOSOwnerCredentials(binding: binding, accessToken: current.accessToken, expiresAt: current.expiresAt)
                    outcome = .success(binding)
                } catch { outcome = .failure(error) }
                self.lock.unlock()
                completion(outcome)
            }
        } catch { completion(.failure(error)) }
    }

    func binding(expectedOwnerId: String) throws -> GuguIOSHostBinding {
        guard let binding = try snapshot(expectedOwnerId: expectedOwnerId) else {
            throw Self.failure("auth_unavailable", "Native owner has not been verified")
        }
        return binding
    }

    func snapshot(expectedOwnerId: String) throws -> GuguIOSHostBinding? {
        lock.lock(); defer { lock.unlock() }
        guard let stored = try readStored() else { return nil }
        guard stored.ownerId == expectedOwnerId else { throw Self.stale() }
        guard !retiring, let active else { return nil }
        guard active.binding.ownerId == expectedOwnerId else { throw Self.stale() }
        guard active.accessToken == stored.accessToken else { return nil }
        try checkInstallation(active.binding)
        guard stored.expiresAt > now(), active.expiresAt > now() else { return nil }
        return active.binding
    }

    func credentials(expectedBinding: GuguIOSHostBinding) throws -> GuguIOSOwnerCredentials {
        lock.lock(); defer { lock.unlock() }
        guard !retiring, let active, active.binding == expectedBinding else { throw Self.stale() }
        _ = try matchingStored(ownerId: expectedBinding.ownerId, accessToken: active.accessToken)
        try checkInstallation(active.binding)
        guard active.expiresAt > now() else { throw Self.failure("auth_expired", "Published access token has expired") }
        return active
    }

    /// AuthStorage must call this barrier before committing retirement or another
    /// owner. A failed stop rejects the write and does not restore native access.
    func prepareMainWrite(nextOwnerId: String?, completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        let previous: String?
        do { previous = try readStored()?.ownerId }
        catch { lock.unlock(); completion(.failure(error)); return }
        if !retiring && previous == nextOwnerId && active?.binding.ownerId == nextOwnerId {
            lock.unlock(); completion(.success(())); return
        }
        generation &+= 1; active = nil; retiring = true
        let issued = generation
        lock.unlock()
        finishStop(issued: issued, completion: completion)
    }

    func retire(expectedOwnerId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        do {
            let storedOwner = try readStored()?.ownerId
            guard (active == nil || active?.binding.ownerId == expectedOwnerId),
                  storedOwner == nil || storedOwner == expectedOwnerId else { throw Self.stale() }
            generation &+= 1; active = nil; retiring = true
        } catch { lock.unlock(); completion(.failure(error)); return }
        let issued = generation
        lock.unlock()
        finishStop(issued: issued, completion: completion)
    }

    private func finishStop(issued: UInt64, completion: @escaping (Result<Void, Error>) -> Void) {
        stopNative { result in
            self.lock.lock()
            let outcome: Result<Void, Error>
            if self.generation != issued { outcome = .failure(Self.stale()) }
            else {
                if case .success = result { self.retiring = false }
                outcome = result
            }
            self.lock.unlock()
            completion(outcome)
        }
    }

    private func matchingStored(ownerId: String, accessToken: String) throws -> GuguIOSStoredSession {
        guard let stored = try readStored(), stored.ownerId == ownerId,
              stored.accessToken == accessToken, !accessToken.isEmpty else { throw Self.stale() }
        guard stored.expiresAt > now() else { throw Self.failure("auth_expired", "Committed access token has expired") }
        return stored
    }

    private func checkInstallation(_ binding: GuguIOSHostBinding) throws {
        guard try installationId() == binding.installationId else { throw Self.stale() }
        try binding.validate()
    }

    private static func stale() -> GuguHostFailure { failure("stale_context", "Native authentication publication is not current") }
    private static func failure(_ code: String, _ message: String) -> GuguHostFailure { GuguHostFailure(code: code, message: message) }
}
