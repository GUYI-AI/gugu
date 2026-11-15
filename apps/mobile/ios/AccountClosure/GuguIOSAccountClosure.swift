import Foundation
import CryptoKit

struct GuguIOSClosureScope: Codable, Equatable {
    let ownerId: String
    let localOperationId: String
    func validate() throws {
        guard UUID(uuidString: ownerId)?.uuidString.lowercased() == ownerId,
              !localOperationId.isEmpty, localOperationId.utf8.count <= 256 else {
            throw GuguIOSAccountClosure.failure("invalid_scope")
        }
    }
}
protocol GuguIOSClosureSecrets {
    func read(_ key: String) throws -> Data?
    func write(_ key: String, data: Data) throws
}

/// Secrets and the original local authorization live only in protected storage.
/// No server authentication or closure request is performed here.
final class GuguIOSAccountClosure {
    struct Outcome { let status: String; let retainedUnattributed: [String] }
    private struct Record: Codable {
        let version: Int
        let scopeDigest: String
        let installationId: String
        var receipt: String?
        var nextStep: Int
        var complete: Bool
        var retained: [String]
    }
    private let lock = NSRecursiveLock()
    private let secrets: GuguIOSClosureSecrets
    private let installation: () throws -> String
    private let localAuthBarrier: (@escaping () throws -> Void) throws -> Void
    private let mainOwner: () throws -> String?
    private let preparation: (GuguIOSClosureScope) throws -> Bool
    private let steps: [(GuguIOSClosureScope) throws -> Bool]
    private let retained: () throws -> [String]

    init(secrets: GuguIOSClosureSecrets, installation: @escaping () throws -> String,
         localAuthBarrier: @escaping (@escaping () throws -> Void) throws -> Void,
         mainOwner: @escaping () throws -> String?, preparation: @escaping (GuguIOSClosureScope) throws -> Bool = { _ in true }, steps: [(GuguIOSClosureScope) throws -> Bool],
         retained: @escaping () throws -> [String]) {
        self.secrets = secrets; self.installation = installation; self.localAuthBarrier = localAuthBarrier
        self.mainOwner = mainOwner; self.preparation = preparation; self.steps = steps; self.retained = retained
    }

    func put(_ scope: GuguIOSClosureScope, receipt: String) throws {
        lock.lock(); defer { lock.unlock() }
        try scope.validate()
        guard !receipt.isEmpty, receipt.utf8.count <= 65536 else { throw Self.failure("invalid_receipt") }
        try localAuthBarrier {
            if let existing = try self.record(scope) {
                guard existing.receipt == receipt else { throw Self.failure("scope_conflict") }
                return
            }
            // The local slot is authoritative even after the remote session died.
            guard try self.mainOwner() == scope.ownerId else { throw Self.failure("wrong_local_owner") }
            let captured = Record(version: 1, scopeDigest: try self.key(scope), installationId: try self.installation(),
                                  receipt: receipt, nextStep: 0, complete: false, retained: [])
            try self.save(captured)
        }
    }
    func get(_ scope: GuguIOSClosureScope) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return try requireRecord(scope).receipt
    }
    func remove(_ scope: GuguIOSClosureScope) throws {
        lock.lock(); defer { lock.unlock() }
        var captured = try requireRecord(scope)
        captured.receipt = nil
        // Retain only the captured operation's tombstone for idempotent remove
        // and completed erase. It cannot authorize a fresh erase without receipt.
        try save(captured)
    }
    func eraseLocal(_ scope: GuguIOSClosureScope) throws -> Outcome {
        lock.lock(); defer { lock.unlock() }
        var captured = try requireRecord(scope)
        if captured.complete { return Outcome(status: "complete", retainedUnattributed: captured.retained) }
        guard captured.receipt != nil else { throw Self.failure("receipt_missing") }
        // In-memory fences and cross-owner retirement preconditions must be
        // revalidated after every process restart, regardless of disk checkpoint.
        guard try preparation(scope) else { return Outcome(status: "pending", retainedUnattributed: try retained()) }
        // Each step is idempotent: a crash after its effect but before checkpoint
        // can repeat that step, never re-enumerate another identity's data.
        while captured.nextStep < steps.count {
            guard try steps[captured.nextStep](scope) else { return Outcome(status: "pending", retainedUnattributed: try retained()) }
            captured.nextStep += 1
            try save(captured)
        }
        captured.retained = try retained(); captured.complete = true
        try save(captured)
        return Outcome(status: "complete", retainedUnattributed: captured.retained)
    }
    private func requireRecord(_ scope: GuguIOSClosureScope) throws -> Record {
        guard let captured = try record(scope) else { throw Self.failure("closure_context_missing") }
        return captured
    }
    private func record(_ scope: GuguIOSClosureScope) throws -> Record? {
        try scope.validate()
        guard let bytes = try secrets.read(key(scope)) else { return nil }
        guard let captured = try? JSONDecoder().decode(Record.self, from: bytes), captured.version == 1,
              captured.scopeDigest == (try key(scope)), captured.installationId == (try installation()),
              (0...steps.count).contains(captured.nextStep) else { throw Self.failure("closure_context_invalid") }
        return captured
    }
    private func save(_ captured: Record) throws { try secrets.write(captured.scopeDigest, data: JSONEncoder().encode(captured)) }
    private func key(_ scope: GuguIOSClosureScope) throws -> String {
        let value = try installation() + ":" + scope.ownerId + ":" + scope.localOperationId
        return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func failure(_ code: String) -> GuguHostFailure {
        .init(code: code, message: "Local account closure storage is unavailable or its scope cannot be used")
    }
}
