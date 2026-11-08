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

    /// Projection of the already-authorized token, never a new authentication
    /// authority. The server independently verifies this same JWT/session scope.
    func originalSessionId() throws -> String {
        try Self.sessionId(ownerId: binding.ownerId, accessToken: accessToken)
    }
    fileprivate static func sessionId(ownerId: String, accessToken: String) throws -> String {
        struct Scope: Decodable { let sub: String; let session_id: String }
        let parts = accessToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, accessToken.utf8.count <= 65536 else { throw Self.invalidScope() }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let bytes = Data(base64Encoded: payload), let scope = try? JSONDecoder().decode(Scope.self, from: bytes),
              scope.sub == ownerId, UUID(uuidString: scope.session_id)?.uuidString.lowercased() == scope.session_id else {
            throw Self.invalidScope()
        }
        return scope.session_id
    }
    private static func invalidScope() -> GuguHostFailure {
        GuguHostFailure(code: "auth_session_invalid", message: "Original authenticated session scope is unavailable")
    }
}

struct GuguIOSMainWritePermit {
    fileprivate let generation: UInt64
    fileprivate let nextOwnerId: String?
    fileprivate let nextAccessToken: String?
    fileprivate let holdsRetirement: Bool
    fileprivate let retirementId: String?
}

/// An opaque, native-only capability for retiring the original push registration.
/// It never reopens ordinary host credentials and is invalid after retirement.
struct GuguIOSRetirementAccess: CustomDebugStringConvertible {
    let binding: GuguIOSHostBinding
    let retirementId: String
    fileprivate let id: UUID
    var debugDescription: String { "GuguIOSRetirementAccess(<redacted>)" }
}

/// The renderer's sessionCoordinator remains the sole refresh authority. Publishing
/// here verifies one already-committed access token; it cannot create or refresh it.
final class GuguIOSOwnerSession {
    typealias Verify = (String, @escaping (Result<String, Error>) -> Void) -> Void
    typealias Stop = (@escaping (Result<Void, Error>) -> Void) -> Void
    typealias RetireExternal = (GuguIOSRetirementAccess?, @escaping (Result<Void, Error>) -> Void) -> Void
    private let lock = NSRecursiveLock()
    private let readStored: () throws -> GuguIOSStoredSession?
    private let installationId: () throws -> String
    private let verifyUser: Verify
    private let stopNative: Stop
    private let retireExternal: RetireExternal?
    private let retirementStore: GuguIOSOwnerRetirementStore?
    private let now: () -> Date
    private var generation: UInt64 = 0
    private var active: GuguIOSOwnerCredentials?
    private var retiring = false
    private var storageRetirementPending = false
    private var retirementAccess: (capability: GuguIOSRetirementAccess, credentials: GuguIOSOwnerCredentials, generation: UInt64)?
    private var retirementVerifiedUntil: Date?

    init(readStored: @escaping () throws -> GuguIOSStoredSession?, installationId: @escaping () throws -> String,
         verifyUser: @escaping Verify, stopNative: @escaping Stop,
         retireExternal: RetireExternal? = nil, retirementStore: GuguIOSOwnerRetirementStore? = nil,
         now: @escaping () -> Date = Date.init) {
        self.readStored = readStored; self.installationId = installationId
        self.verifyUser = verifyUser; self.stopNative = stopNative
        self.retireExternal = retireExternal; self.retirementStore = retirementStore; self.now = now
    }

    func publish(ownerId: String, accessToken: String,
                 completion: @escaping (Result<GuguIOSHostBinding, Error>) -> Void) {
        do {
            lock.lock()
            let stored: GuguIOSStoredSession
            do {
                try restoreRetirementBarrier()
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
                    try self.requireNoDurableRetirement()
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
        try restoreRetirementBarrier()
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
        try restoreRetirementBarrier()
        guard !retiring, let active, active.binding == expectedBinding else { throw Self.stale() }
        _ = try matchingStored(ownerId: expectedBinding.ownerId, accessToken: active.accessToken)
        try checkInstallation(active.binding)
        guard active.expiresAt > now() else { throw Self.failure("auth_expired", "Published access token has expired") }
        return active
    }

    /// Checks only a response to a request already admitted with these native
    /// credentials. It issues no credential and cannot authorize another request.
    /// Retaining this original ack lets push cleanup settle an in-flight register
    /// after ordinary publication has closed, without moving it to a new session.
    func validateIssuedPushReceipt(_ issued: GuguIOSOwnerCredentials) throws {
        lock.lock(); defer { lock.unlock() }
        _ = try matchingStored(ownerId: issued.binding.ownerId, accessToken: issued.accessToken)
        try checkInstallation(issued.binding)
        guard issued.expiresAt > now() else { throw Self.failure("auth_expired", "Issued notification access has expired") }
        if storageRetirementPending {
            guard let access = retirementAccess, access.generation == generation,
                  access.credentials.binding == issued.binding,
                  access.credentials.accessToken == issued.accessToken else { throw Self.stale() }
        }
    }

    /// Only the assembled push provider receives the capability. It must expose
    /// named retirement RPCs, never this access token or a generic cloud call.
    func retirementCredentials(_ capability: GuguIOSRetirementAccess,
                               expectedBinding: GuguIOSHostBinding) throws -> GuguIOSOwnerCredentials {
        lock.lock(); defer { lock.unlock() }
        guard retiring, let access = retirementAccess, access.generation == generation,
              access.capability.id == capability.id, capability.binding == expectedBinding,
              access.credentials.binding == expectedBinding else { throw Self.stale() }
        if let retirementStore {
            guard let record = try retirementStore.snapshot(), record.id == capability.retirementId,
                  record.original?.binding == expectedBinding,
                  record.original?.accessSHA256 == GuguIOSOwnerRetirementStore.digest(access.credentials.accessToken),
                  let until = retirementVerifiedUntil, until > now() else { throw Self.stale() }
        }
        _ = try matchingStored(ownerId: expectedBinding.ownerId, accessToken: access.credentials.accessToken)
        try checkInstallation(expectedBinding)
        guard access.credentials.expiresAt > now() else { throw Self.failure("auth_expired", "Retirement access has expired") }
        return access.credentials
    }

    /// AuthStorage must call this barrier before committing retirement or another
    /// owner. A failed stop rejects the write and does not restore native access.
    func prepareMainWrite(nextOwnerId: String?, nextAccessToken: String? = nil, completion: @escaping (Result<GuguIOSMainWritePermit, Error>) -> Void) {
        lock.lock()
        let stored: GuguIOSStoredSession?
        do {
            try restoreRetirementBarrier()
            stored = try readStored()
        }
        catch {
            // Failure to read the old envelope must not leave its native access
            // alive while a retirement/write intent is already in flight.
            generation &+= 1; active = nil; retiring = true; retirementAccess = nil; storageRetirementPending = true
            retirementVerifiedUntil = nil
            // Even an unreadable old Keychain envelope leaves a durable intent.
            // Failure to persist this intent is propagated and never admits a write.
            var failure: Error = error
            do {
                if let retirementStore {
                    _ = try retirementStore.begin(target: .init(ownerId: nextOwnerId, accessToken: nextAccessToken))
                }
            } catch { failure = error }
            lock.unlock()
            stopNative { _ in completion(.failure(failure)) }
            return
        }
        let sameAuthSession: Bool
        if let stored, let nextOwnerId, let nextAccessToken,
           stored.ownerId == nextOwnerId,
           let oldSession = try? GuguIOSOwnerCredentials.sessionId(ownerId: stored.ownerId, accessToken: stored.accessToken),
           let newSession = try? GuguIOSOwnerCredentials.sessionId(ownerId: nextOwnerId, accessToken: nextAccessToken) {
            sameAuthSession = oldSession == newSession
        } else { sameAuthSession = false }
        if !retiring && sameAuthSession && (active == nil || active?.binding.ownerId == nextOwnerId) {
            let permit = GuguIOSMainWritePermit(generation: generation, nextOwnerId: nextOwnerId,
                nextAccessToken: nextAccessToken, holdsRetirement: false, retirementId: nil)
            lock.unlock(); completion(.success(permit)); return
        }
        generation &+= 1; active = nil; retiring = true; storageRetirementPending = true
        retirementVerifiedUntil = nil
        let issued = generation
        let capability: GuguIOSRetirementAccess?
        do {
            if let retirementStore {
                let record = try retirementStore.begin(target: .init(ownerId: nextOwnerId, accessToken: nextAccessToken))
                let original = try originalRetirement(stored)
                _ = try retirementStore.capture(id: record.id, original: original)
            }
            capability = try captureRetirement(stored)
        }
        catch {
            retirementAccess = nil; lock.unlock()
            stopNative { _ in completion(.failure(error)) }
            return
        }
        lock.unlock()
        runRetirement(issued: issued, capability: capability) { result in
            self.lock.lock()
            let outcome: Result<GuguIOSMainWritePermit, Error>
            do {
                guard self.generation == issued else { throw Self.stale() }
                try result.get()
                outcome = .success(GuguIOSMainWritePermit(generation: issued, nextOwnerId: nextOwnerId,
                    nextAccessToken: nextAccessToken, holdsRetirement: true,
                    retirementId: try self.retirementStore?.snapshot()?.id))
            } catch { outcome = .failure(error) }
            self.lock.unlock(); completion(outcome)
        }
    }

    /// AuthStorage invokes its synchronous Keychain write under this generation
    /// check. Stop success alone must not reopen a failed logout storage commit.
    func commitMainWrite(_ permit: GuguIOSMainWritePermit, persist: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard generation == permit.generation,
              !retiring || permit.holdsRetirement else { throw Self.stale() }
        if let retirementStore {
            if permit.holdsRetirement && permit.retirementId == nil { throw Self.stale() }
            try retirementStore.commit(id: permit.retirementId,
                target: .init(ownerId: permit.nextOwnerId, accessToken: permit.nextAccessToken)) {
                try persist()
                return try readBackMainWrite(permit)
            }
        } else { try persist(); _ = try readBackMainWrite(permit) }
        generation &+= 1
        retirementAccess = nil
        retirementVerifiedUntil = nil
        if permit.holdsRetirement { retiring = false; storageRetirementPending = false }
    }

    private func readBackMainWrite(_ permit: GuguIOSMainWritePermit) throws -> GuguIOSStoredSession? {
        let current = try readStored()
        guard current?.ownerId == permit.nextOwnerId,
              permit.nextAccessToken == nil || current?.accessToken == permit.nextAccessToken else {
            retiring = true; active = nil; storageRetirementPending = true
            throw Self.failure("auth_storage_invalid", "Native login write did not preserve the prepared owner")
        }
        return current
    }

    func retire(expectedOwnerId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        let capability: GuguIOSRetirementAccess?
        let requiresStorageCleanup: Bool
        do {
            try restoreRetirementBarrier()
            requiresStorageCleanup = storageRetirementPending
            let stored = try readStored()
            let storedOwner = stored?.ownerId
            guard (active == nil || active?.binding.ownerId == expectedOwnerId),
                  storedOwner == nil || storedOwner == expectedOwnerId else { throw Self.stale() }
            generation &+= 1; active = nil; retiring = true
            do {
                // A WebView/publication stop retains its existing Auth session.
                // Permanent push close belongs only to a credential-write intent.
                capability = requiresStorageCleanup ? try captureRetirement(stored) : nil
                if !requiresStorageCleanup { retirementAccess = nil }
            }
            catch {
                retirementAccess = nil; lock.unlock()
                stopNative { _ in completion(.failure(error)) }
                return
            }
        } catch { lock.unlock(); completion(.failure(error)); return }
        let issued = generation
        lock.unlock()
        finishStop(issued: issued, capability: capability, requiresStorageCleanup: requiresStorageCleanup, completion: completion)
    }

    private func finishStop(issued: UInt64, capability: GuguIOSRetirementAccess?, requiresStorageCleanup: Bool,
                            completion: @escaping (Result<Void, Error>) -> Void) {
        let finished: (Result<Void, Error>) -> Void = { result in
            self.lock.lock()
            let outcome: Result<Void, Error>
            if self.generation != issued { outcome = .failure(Self.stale()) }
            else {
                if case .success = result, !self.storageRetirementPending { self.retiring = false }
                outcome = result
            }
            self.lock.unlock()
            completion(outcome)
        }
        if requiresStorageCleanup { runRetirement(issued: issued, capability: capability, completion: finished) }
        else { stopNative(finished) }
    }

    private func captureRetirement(_ stored: GuguIOSStoredSession?) throws -> GuguIOSRetirementAccess? {
        retirementAccess = nil
        retirementVerifiedUntil = nil
        if let record = try retirementStore?.snapshot() {
            guard record.captureComplete, record.original == (try originalRetirement(stored)) else { throw Self.stale() }
        }
        guard retireExternal != nil, let stored else { return nil }
        let install = try installationId()
        let binding = GuguIOSHostBinding(ownerId: stored.ownerId,
            deviceId: "phone-\(install)-\(stored.ownerId)", installationId: install)
        try binding.validate()
        let transactionId = try retirementStore?.snapshot()?.id ?? UUID().uuidString.lowercased()
        let capability = GuguIOSRetirementAccess(binding: binding, retirementId: transactionId, id: UUID())
        retirementAccess = (capability, GuguIOSOwnerCredentials(binding: binding,
            accessToken: stored.accessToken, expiresAt: stored.expiresAt), generation)
        return capability
    }

    private func runRetirement(issued: UInt64, capability: GuguIOSRetirementAccess?,
                               completion: @escaping (Result<Void, Error>) -> Void) {
        let durableTransaction = Result { try retirementStore?.snapshot() }
        // Both branches must finish, even when one fails; a network failure must
        // not leave local model/tool transports running or permit a Keychain write.
        let resultLock = NSLock()
        var externalResult: Result<Void, Error>?, localResult: Result<Void, Error>?
        var delivered = false
        let finish = {
            resultLock.lock()
            guard !delivered, let external = externalResult, let local = localResult else { resultLock.unlock(); return }
            delivered = true; resultLock.unlock()
            let outcome: Result<Void, Error>
            do {
                try external.get(); try local.get()
                self.lock.lock()
                defer { self.lock.unlock() }
                guard self.generation == issued else { throw Self.stale() }
                let originalTransaction = try durableTransaction.get()
                guard try self.retirementStore?.snapshot()?.id == originalTransaction?.id else { throw Self.stale() }
                if let record = originalTransaction {
                    try self.retirementStore?.markCleanupComplete(id: record.id)
                }
                self.retirementAccess = nil; self.retirementVerifiedUntil = nil
                outcome = .success(())
            } catch { outcome = .failure(error) }
            completion(outcome)
        }
        if let retireExternal {
            let complete: (Result<Void, Error>) -> Void = { result in
                resultLock.lock(); if case nil = externalResult { externalResult = result }; resultLock.unlock(); finish()
            }
            if retirementStore != nil, let capability {
                verifyRetirement(capability) { result in
                    do { try result.get(); retireExternal(capability, complete) }
                    catch { complete(.failure(error)) }
                }
            } else {
                retireExternal(capability, complete)
            }
        } else { externalResult = .success(()) }
        stopNative { result in
            resultLock.lock(); if case nil = localResult { localResult = result }; resultLock.unlock(); finish()
        }
    }

    private func originalRetirement(_ stored: GuguIOSStoredSession?) throws -> GuguIOSOwnerRetirementStore.Original? {
        guard let stored else { return nil }
        let install = try installationId()
        let binding = GuguIOSHostBinding(ownerId: stored.ownerId, deviceId: "phone-\(install)-\(stored.ownerId)", installationId: install)
        try binding.validate()
        return .init(binding: binding, sessionId: try GuguIOSOwnerCredentials.sessionId(ownerId: stored.ownerId, accessToken: stored.accessToken),
                     accessSHA256: GuguIOSOwnerRetirementStore.digest(stored.accessToken))
    }

    private func verifyRetirement(_ capability: GuguIOSRetirementAccess, completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        guard let issued = retirementAccess, issued.capability.id == capability.id else {
            lock.unlock(); completion(.failure(Self.stale())); return
        }
        let token = issued.credentials.accessToken
        lock.unlock()
        verifyUser(token) { result in
            self.lock.lock()
            let outcome: Result<Void, Error>
            do {
                guard try result.get() == capability.binding.ownerId,
                      let current = self.retirementAccess, current.capability.id == capability.id,
                      current.generation == self.generation, self.retiring,
                      let record = try self.retirementStore?.snapshot(), record.id == capability.retirementId,
                      record.original == (try self.originalRetirement(self.readStored())) else { throw Self.stale() }
                _ = try self.matchingStored(ownerId: capability.binding.ownerId, accessToken: token)
                try self.checkInstallation(capability.binding)
                self.retirementVerifiedUntil = min(current.credentials.expiresAt, self.now().addingTimeInterval(300))
                outcome = .success(())
            } catch { outcome = .failure(error) }
            self.lock.unlock(); completion(outcome)
        }
    }

    private func requireNoDurableRetirement() throws {
        guard try retirementStore?.snapshot() == nil else { throw Self.stale() }
    }

    private func restoreRetirementBarrier() throws {
        guard let retirementStore else { return }
        if let record = try retirementStore.snapshot() {
            if record.cleanupComplete, try retirementStore.recoverCommittedWrite(stored: readStored()) {
                generation &+= 1; active = nil; retiring = false; storageRetirementPending = false
                retirementAccess = nil; retirementVerifiedUntil = nil
                return
            }
            active = nil; retiring = true; storageRetirementPending = true
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
