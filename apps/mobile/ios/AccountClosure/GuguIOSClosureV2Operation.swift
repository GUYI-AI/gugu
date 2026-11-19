import Foundation
import CryptoKit

/// Auth commits and protected V2 writes use the same process-wide lock, including
/// the plugin's fallback construction before AppRuntime has been assembled.
enum GuguIOSClosureV2Storage {
    static let lock = NSRecursiveLock()
    // Held before the Auth barrier by V1 actions and V2 capture only. Never
    // acquired by ordinary publication or by native stop callbacks.
    static let captureLock = NSRecursiveLock()
    static func protectAuthWrite(bundleIdentifier: String, ownerId: String?) throws {
        guard let ownerId else { return }
        let operations = GuguIOSClosureV2Operation(secrets: GuguIOSClosureKeychain(bundleIdentifier: bundleIdentifier),
            barrier: { try $0() }, identity: { _, _ in throw GuguIOSClosureV2Operation.failure("scope_conflict") },
            entropy: { throw GuguIOSClosureV2Operation.failure("closure_storage_unavailable") })
        try operations.requireAuthWrite(ownerId: ownerId)
    }
}

struct GuguIOSClosureV2Handle: Codable, Equatable {
    let localOperationId: String
    let nativeGeneration: String
    let localRevision: Int64
}

/// Native facts only. These values and the receipt never cross a plugin result.
struct GuguIOSClosureV2Identity {
    let ownerId: String
    let sessionId: String
    let installationId: String
    let deviceId: String
    let backend: String
    let authenticated: Bool
}

struct GuguIOSClosureV2Protocol: Codable {
    var operationId: String?
    var state: String?
    var operationRevision: Int64 = 0
    var challengeGeneration: Int = 0
    var attemptedChallengeGeneration: Int = 0
    var challengeExpiresAt: TimeInterval = 0
    var serverGeneration: String?
    var requestId: String?
    var confirmationId: String?
    var pendingRoute: String?
    var codeSent = false
    var confirmationRejected = false
    var cancelRequested = false
    var confirmCancellationBlocked = false
    var resumeRequired = false
    var cancelled = false
    var finalized = false
    var cleanupStep = 0
    var retained: [String] = []
    var deleted: Bool { state == "deleted" }
    var released: Bool { cancelled || finalized }
    mutating func requestCancellation() throws {
        guard !released, !deleted, !confirmCancellationBlocked else { throw GuguIOSClosureV2Operation.failure("closure_recovery_required") }
        cancelRequested = true
        if pendingRoute != "confirm" { pendingRoute = "cancel" }
    }
}

struct GuguIOSClosureV2Record: Codable {
    let ownerId: String
    let localOperationId: String
    let originalSessionId: String
    let installationId: String
    let deviceId: String
    let backend: String
    let nativeGeneration: String
    var localRevision: Int64
    var checkpoint: String
    var receipt: Data
    var facts: GuguIOSClosureV2Protocol
    var handle: GuguIOSClosureV2Handle {
        .init(localOperationId: localOperationId, nativeGeneration: nativeGeneration, localRevision: localRevision)
    }
}

/// One atomic protected index carries both discovery and all per-owner capabilities.
/// The injected barrier is OwnerSession's existing synchronous Auth commit lock.
final class GuguIOSClosureV2Operation {
    typealias Barrier = (@escaping () throws -> Void) throws -> Void
    typealias Identity = (String, Bool) throws -> GuguIOSClosureV2Identity
    private struct Index: Codable {
        let version: Int
        var selectedOwner: String?
        var owners: [String: GuguIOSClosureV2Record]
    }
    private let secrets: GuguIOSClosureSecrets
    private let barrier: Barrier
    private let identity: Identity
    private let entropy: () throws -> Data
    private let captureAdmission: (String) throws -> Void
    private static let key = SHA256.hash(data: Data("gugu-account-closure/v2/native-index".utf8)).map { String(format: "%02x", $0) }.joined()
    static let retainedNames: Set<String> = ["auth-main-unattributed", "auth-code-verifier", "auth-oauth-pending", "files-staging", "retirement-unattributed", "push-deduplication"]
    private static let states: Set<String> = ["open", "confirming", "processing", "deleted", "closed_before_confirm"]
    private static let maximumRevision: Int64 = 9_007_199_254_740_991

    init(secrets: GuguIOSClosureSecrets, barrier: @escaping Barrier,
         identity: @escaping Identity, entropy: @escaping () throws -> Data,
         captureAdmission: @escaping (String) throws -> Void = { _ in }) {
        self.secrets = secrets; self.barrier = barrier; self.identity = identity; self.entropy = entropy
        self.captureAdmission = captureAdmission
    }
    private func locked<T>(_ body: @escaping () throws -> T) throws -> T {
        var result: Result<T, Error>?
        try barrier {
            GuguIOSClosureV2Storage.lock.lock(); defer { GuguIOSClosureV2Storage.lock.unlock() }
            result = Result { try body() }
        }
        guard let result else { throw Self.failure("closure_storage_unavailable") }
        return try result.get()
    }
    func capture(ownerId: String) throws -> GuguIOSClosureV2Record {
        GuguIOSClosureV2Storage.captureLock.lock(); defer { GuguIOSClosureV2Storage.captureLock.unlock() }
        return try locked {
            let current = try self.identity(ownerId, false)
            guard current.authenticated else { throw Self.failure("unauthorized") }
            try self.captureAdmission(ownerId)
            var index = try self.load()
            if let original = index.owners[ownerId], !original.facts.cancelled {
                guard !original.facts.finalized else { throw Self.failure("closure_recovery_required") }
                try Self.binding(original, current); return original
            }
            let receipt = try self.entropy()
            guard receipt.count == 32 else { throw Self.failure("closure_storage_unavailable") }
            var facts = GuguIOSClosureV2Protocol()
            facts.resumeRequired = index.owners[ownerId]?.facts.resumeRequired == true
            let captured = GuguIOSClosureV2Record(ownerId: ownerId, localOperationId: UUID().uuidString.lowercased(),
                originalSessionId: current.sessionId, installationId: current.installationId, deviceId: current.deviceId,
                backend: current.backend, nativeGeneration: UUID().uuidString.lowercased(), localRevision: 1,
                checkpoint: "captured", receipt: receipt, facts: facts)
            try Self.validate(captured)
            index.owners[ownerId] = captured; index.selectedOwner = ownerId
            try self.save(index); return captured
        }
    }
    func protectedRecord(ownerId: String) throws -> GuguIOSClosureV2Record? {
        try locked { try self.load().owners[ownerId] }
    }
    func discover(currentOwnerId: String?) throws -> GuguIOSClosureV2Record? {
        try locked {
            let index = try self.load()
            let candidates: [GuguIOSClosureV2Record]
            if let owner = currentOwnerId { candidates = index.owners[owner].map { [$0] } ?? [] }
            else {
                let preferred = index.selectedOwner.flatMap { index.owners[$0] }
                candidates = (preferred.map { [$0] } ?? []) + index.owners.values.filter { $0.ownerId != index.selectedOwner }.sorted { $0.ownerId < $1.ownerId }
            }
            for record in candidates where !record.facts.released {
                try self.validateBinding(record, recovering: true); return record
            }
            return nil
        }
    }
    func resolve(_ handle: GuguIOSClosureV2Handle, currentOwnerId: String?, recovering: Bool) throws -> GuguIOSClosureV2Record {
        try locked {
            let index = try self.load()
            guard let record = index.owners.values.first(where: { $0.localOperationId == handle.localOperationId
                && (currentOwnerId == nil || currentOwnerId == $0.ownerId) }) else { throw Self.failure("closure_context_missing") }
            try self.validateBinding(record, recovering: recovering)
            guard record.handle == handle else { throw Self.failure("scope_conflict") }
            return record
        }
    }
    /// Package native receiver only. No plugin accepts a record mutation or cloud state.
    func update(_ expected: GuguIOSClosureV2Record, recovering: Bool = false,
                _ mutation: @escaping (inout GuguIOSClosureV2Record) throws -> Void) throws -> GuguIOSClosureV2Record {
        try locked {
            var index = try self.load()
            guard var record = index.owners[expected.ownerId], record.handle == expected.handle else { throw Self.failure("scope_conflict") }
            try self.validateBinding(record, recovering: recovering)
            try mutation(&record)
            guard record.localRevision < Self.maximumRevision else { throw Self.failure("scope_conflict") }
            record.localRevision += 1; try Self.validate(record)
            index.owners[record.ownerId] = record; try self.save(index); return record
        }
    }
    func nativeReceipt(_ expected: GuguIOSClosureV2Record, recovering: Bool) throws -> String {
        try locked {
            guard let record = try self.load().owners[expected.ownerId], record.handle == expected.handle, !record.facts.released else {
                throw Self.failure("scope_conflict")
            }
            try self.validateBinding(record, recovering: recovering)
            return record.receipt.map { String(format: "%02x", $0) }.joined()
        }
    }
    func validatePreparation(_ expected: GuguIOSClosureV2Record, recovering: Bool) throws {
        try locked {
            guard let current = try self.load().owners[expected.ownerId], current.handle == expected.handle,
                  current.checkpoint == "preparing", !current.facts.released,
                  !recovering || current.facts.deleted else { throw Self.failure("scope_conflict") }
            try self.validateBinding(current, recovering: recovering)
        }
    }
    func requireOpen(ownerId: String) throws {
        try locked {
            if let record = try self.load().owners[ownerId], !record.facts.cancelled || record.facts.resumeRequired {
                throw Self.failure("closure_recovery_required")
            }
        }
    }
    func requireAuthWrite(ownerId: String?) throws {
        guard let ownerId else { return }
        try locked {
            if let record = try self.load().owners[ownerId], record.facts.deleted {
                throw Self.failure("closure_recovery_required")
            }
        }
    }
    /// Explicit owner UI only. Ordinary reconciliation never calls this method.
    func resumeAfterCancellation(ownerId: String, idle: () throws -> Bool) throws {
        let admitted: GuguIOSClosureV2Identity = try locked {
            let current = try self.identity(ownerId, false)
            guard current.authenticated, current.ownerId == ownerId else { throw Self.failure("unauthorized") }
            return current
        }
        guard try idle() else { throw Self.failure("closure_not_prepared") }
        try locked {
            let current = try self.identity(ownerId, false)
            guard current.authenticated, current.ownerId == admitted.ownerId, current.sessionId == admitted.sessionId,
                  current.installationId == admitted.installationId, current.deviceId == admitted.deviceId,
                  current.backend == admitted.backend else { throw Self.failure("scope_conflict") }
            var index = try self.load()
            guard var record = index.owners[ownerId] else { return }
            guard record.facts.cancelled, record.installationId == current.installationId,
                  record.deviceId == current.deviceId, record.backend == current.backend else { throw Self.failure("closure_recovery_required") }
            if !record.facts.resumeRequired { return }
            record.facts.resumeRequired = false; record.localRevision += 1
            try Self.validate(record); index.owners[ownerId] = record; try self.save(index)
        }
    }
    /// Each idempotent step and its checkpoint share the native Auth mutation barrier.
    func cleanDeleted(_ expected: GuguIOSClosureV2Record, idle: Bool,
                      erase: @escaping (Int, String) throws -> Void, retained: @escaping () throws -> [String]) throws -> GuguIOSClosureV2Record {
        guard idle else { throw Self.failure("closure_not_prepared") }
        return try locked {
            var index = try self.load()
            guard var record = index.owners[expected.ownerId], record.handle == expected.handle,
                  record.facts.deleted, record.checkpoint == "local_prepared" else { throw Self.failure("closure_not_prepared") }
            try self.validateBinding(record, recovering: true)
            while record.facts.cleanupStep < 5 {
                try erase(record.facts.cleanupStep, record.ownerId)
                record.facts.cleanupStep += 1; record.localRevision += 1
                try Self.validate(record); index.owners[record.ownerId] = record; try self.save(index)
                try self.validateBinding(record, recovering: true)
            }
            record.facts.retained = try retained(); record.localRevision += 1
            try Self.validate(record); index.owners[record.ownerId] = record; try self.save(index); return record
        }
    }
    func finalize(_ expected: GuguIOSClosureV2Record) throws -> GuguIOSClosureV2Record {
        try update(expected, recovering: true) { record in
            guard record.facts.deleted, record.facts.cleanupStep == 5,
                  try !self.identity(record.ownerId, true).authenticated else { throw Self.failure("closure_not_complete") }
            record.facts.finalized = true; record.receipt = Data(repeating: 0, count: 32)
        }
    }
    private func load() throws -> Index {
        guard let bytes = try secrets.read(Self.key) else { return .init(version: 1, selectedOwner: nil, owners: [:]) }
        guard bytes.count <= 100_000, let index = try? JSONDecoder().decode(Index.self, from: bytes), index.version == 1,
              !index.owners.isEmpty, index.owners.count <= 128, let selected = index.selectedOwner,
              index.owners[selected] != nil else { throw Self.failure("closure_storage_unavailable") }
        for (owner, record) in index.owners {
            guard owner == record.ownerId else { throw Self.failure("closure_storage_unavailable") }
            try Self.validate(record)
        }
        return index
    }
    private func save(_ index: Index) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(index)
        guard bytes.count <= 100_000 else { throw Self.failure("closure_storage_unavailable") }
        try secrets.write(Self.key, data: bytes)
    }
    private static func binding(_ record: GuguIOSClosureV2Record, _ current: GuguIOSClosureV2Identity) throws {
        guard record.ownerId == current.ownerId else { throw failure("wrong_local_owner") }
        guard record.originalSessionId == current.sessionId, record.installationId == current.installationId,
              record.deviceId == current.deviceId, record.backend == current.backend else { throw failure("scope_conflict") }
    }
    private func validateBinding(_ record: GuguIOSClosureV2Record, recovering: Bool) throws {
        let current = try identity(record.ownerId, recovering)
        guard recovering || current.authenticated else { throw Self.failure("unauthorized") }
        try Self.binding(record, current)
    }
    private static func canonical(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    private static func validate(_ record: GuguIOSClosureV2Record) throws {
        let facts = record.facts
        guard [record.ownerId, record.localOperationId, record.originalSessionId, record.installationId, record.nativeGeneration].allSatisfy(canonical),
              record.deviceId == "phone-\(record.installationId)-\(record.ownerId)", !record.backend.isEmpty, record.backend.utf8.count <= 2048,
              record.receipt.count == 32, (1...maximumRevision).contains(record.localRevision),
              ["captured", "preparing", "local_prepared"].contains(record.checkpoint),
              [facts.operationId, facts.serverGeneration, facts.requestId, facts.confirmationId].compactMap({ $0 }).allSatisfy(canonical),
              (facts.operationId == nil ? facts.state == nil && facts.operationRevision == 0 :
                facts.state.map { states.contains($0) } == true && (1...maximumRevision).contains(facts.operationRevision)),
              (0...Int(Int32.max)).contains(facts.challengeGeneration), (0...Int(Int32.max)).contains(facts.attemptedChallengeGeneration),
              facts.challengeExpiresAt.isFinite, facts.challengeExpiresAt >= 0,
              (0...5).contains(facts.cleanupStep), facts.cleanupStep == 0 || facts.deleted,
              !facts.finalized || facts.cleanupStep == 5, !facts.cancelled || facts.state == "closed_before_confirm",
              !facts.confirmationRejected || facts.confirmationId != nil,
              !facts.cancelRequested || ["confirm", "cancel"].contains(facts.pendingRoute ?? ""),
              !facts.confirmCancellationBlocked || facts.cancelRequested,
              facts.pendingRoute.map { ["register", "challenge", "prepare_device", "confirm", "cancel"].contains($0) } ?? true,
              Set(facts.retained).count == facts.retained.count, Set(facts.retained).isSubset(of: retainedNames) else {
            throw failure("closure_storage_unavailable")
        }
    }
    static func failure(_ code: String) -> GuguHostFailure { .init(code: code, message: "Native account closure could not be completed") }
}
