import Foundation

/// The plugin supplies UI intent only. Native custody owns every request binding,
/// confirmation nonce, receipt, durable side effect and original-account cleanup.
actor GuguIOSClosureV2Facade {
    struct Session {
        let ownerId: String
        let sessionId: String
        let accessToken: String
    }
    enum Action: Equatable { case policy, discover, capture, sendCode, prepare, confirm, recover, cancel, finalize }
    private let store: GuguIOSClosureV2Operation
    private let transport: GuguIOSClosureV2HTTP
    private let session: () throws -> Session?
    private let prepareLocal: (GuguIOSClosureV2Record, Bool) async throws -> Bool
    private let erase: (Int, String) throws -> Void
    private let retained: () throws -> [String]
    private let beforeCapture: () throws -> Void
    private var busy = false
    private static let consent = "immediate-forfeit-v1"

    init(store: GuguIOSClosureV2Operation, transport: GuguIOSClosureV2HTTP,
         session: @escaping () throws -> Session?,
         prepareLocal: @escaping (GuguIOSClosureV2Record, Bool) async throws -> Bool,
         erase: @escaping (Int, String) throws -> Void, retained: @escaping () throws -> [String], beforeCapture: @escaping () throws -> Void = {}) {
        self.store = store; self.transport = transport; self.session = session
        self.prepareLocal = prepareLocal; self.erase = erase; self.retained = retained
        self.beforeCapture = beforeCapture
    }

    func execute(_ action: Action, handle: GuguIOSClosureV2Handle? = nil,
                 code: String? = nil, acknowledgeForfeit: Bool = false) async throws -> [String: Any]? {
        guard !busy else { throw failure("closure_busy") }
        busy = true; defer { busy = false }
        switch action {
        case .policy:
            let original = try currentSession()
            let policy = try GuguIOSClosureV2Policy.decode(await request("status", bearer: original.accessToken, body: nil))
            try sameSession(original); return policy.snapshot
        case .discover:
            return try store.discover(currentOwnerId: session()?.ownerId).map(Self.snapshot)
        case .capture:
            if let pending = try store.discover(currentOwnerId: session()?.ownerId) { return Self.snapshot(pending) }
            let original = try currentSession()
            let policy = try GuguIOSClosureV2Policy.decode(await request("status", bearer: original.accessToken, body: nil))
            guard policy.available else { throw failure("closure_not_available") }
            try sameSession(original)
            try beforeCapture()
            var record = try store.capture(ownerId: original.ownerId)
            record = try intent(record, route: "register") { _ in }
            var body = try binding(record); body["consent_version"] = Self.consent
            return Self.snapshot(try await receive(record, route: "register", body: body))
        default: break
        }
        guard let handle else { throw failure("invalid_request") }
        let recovering = action == .recover || action == .finalize
        var record = try store.resolve(handle, currentOwnerId: session()?.ownerId, recovering: recovering)
        switch action {
        case .sendCode:
            try requireOpen(record)
            guard record.facts.challengeGeneration < Int(Int32.max) else { throw failure("scope_conflict") }
            record = try intent(record, route: "challenge") { facts in
                facts.attemptedChallengeGeneration = facts.challengeGeneration + 1
                facts.codeSent = false; facts.challengeExpiresAt = 0
            }
            var body = try binding(record); body["consent_version"] = Self.consent
            body["generation"] = record.facts.attemptedChallengeGeneration
            return Self.snapshot(try await receive(record, route: "challenge", body: body))
        case .prepare:
            try requireOpen(record)
            guard record.facts.codeSent, record.facts.challengeGeneration > 0 else { throw failure("challenge_required") }
            record = try await drain(record, recovering: false)
            if record.facts.serverGeneration != nil { return Self.snapshot(record) }
            record = try intent(record, route: "prepare_device") { _ in }
            var body = try binding(record); body["device_id"] = record.deviceId
            body["native_generation"] = record.nativeGeneration
            return Self.snapshot(try await receive(record, route: "prepare_device", body: body))
        case .confirm:
            try requireOpen(record)
            guard acknowledgeForfeit, let code, code.range(of: "^[0-9]{6,10}$", options: .regularExpression) != nil else {
                throw failure("invalid_request")
            }
            guard record.checkpoint == "local_prepared", let serverGeneration = record.facts.serverGeneration,
                  record.facts.codeSent else { throw failure("closure_not_prepared") }
            guard record.facts.challengeExpiresAt == 0 || record.facts.challengeExpiresAt > Date().timeIntervalSince1970 else {
                throw failure("verification_failed")
            }
            record = try intent(record, route: "confirm") { facts in
                facts.confirmationId = UUID().uuidString.lowercased(); facts.confirmationRejected = false
                facts.cancelRequested = false; facts.confirmCancellationBlocked = false
            }
            var body = try binding(record)
            body["consent_version"] = Self.consent; body["generation"] = record.facts.challengeGeneration
            body["confirmation_id"] = record.facts.confirmationId; body["native_generation"] = record.nativeGeneration
            body["server_generation"] = serverGeneration; body["code"] = code; body["acknowledge_forfeit"] = true
            let confirmed = try await receive(record, route: "confirm", body: body)
            return Self.snapshot(try await cleanDeleted(confirmed))
        case .recover:
            if record.facts.released { return Self.snapshot(record) }
            let body = try binding(record, recovering: true)
            let recovered = try await receive(record, route: "result", body: body)
            return Self.snapshot(try await cleanDeleted(recovered))
        case .cancel:
            if record.facts.cancelled { return Self.snapshot(record) }
            guard !record.facts.deleted else { throw failure("request_active") }
            record = try store.update(record) { try $0.facts.requestCancellation() }
            var body = try binding(record); body["native_generation"] = record.nativeGeneration
            if let generation = record.facts.serverGeneration { body["server_generation"] = generation }
            return Self.snapshot(try await receive(record, route: "cancel", body: body))
        case .finalize:
            return Self.snapshot(try store.finalize(record))
        default: throw failure("invalid_request")
        }
    }

    private func drain(_ expected: GuguIOSClosureV2Record, recovering: Bool) async throws -> GuguIOSClosureV2Record {
        let preparing = try store.update(expected, recovering: recovering) { record in
            guard !record.facts.released, !recovering || record.facts.deleted else { throw self.failure("closure_not_prepared") }
            record.checkpoint = "preparing"; record.facts.resumeRequired = true
        }
        guard try await prepareLocal(preparing, recovering) else { throw failure("closure_not_prepared") }
        try store.validatePreparation(preparing, recovering: recovering)
        return try store.update(preparing, recovering: recovering) { $0.checkpoint = "local_prepared" }
    }
    private func cleanDeleted(_ incoming: GuguIOSClosureV2Record) async throws -> GuguIOSClosureV2Record {
        if !incoming.facts.deleted || incoming.facts.finalized || incoming.facts.cleanupStep == 5 { return incoming }
        let prepared = try await drain(incoming, recovering: true)
        let retainedNames = try retained()
        return try store.cleanDeleted(prepared, idle: true, erase: erase, retained: { retainedNames })
    }
    private func intent(_ expected: GuguIOSClosureV2Record, route: String,
                        mutation: @escaping (inout GuguIOSClosureV2Protocol) throws -> Void) throws -> GuguIOSClosureV2Record {
        try store.update(expected) { record in
            guard !record.facts.released, !record.facts.deleted, record.facts.pendingRoute == nil else { throw self.failure("closure_recovery_required") }
            try mutation(&record.facts); record.facts.pendingRoute = route
        }
    }
    private func receive(_ expected: GuguIOSClosureV2Record, route: String, body: [String: Any]) async throws -> GuguIOSClosureV2Record {
        var bearer: String?
        if route != "result" {
            let current = try currentSession()
            guard current.ownerId == expected.ownerId, current.sessionId == expected.originalSessionId else { throw failure("scope_conflict") }
            _ = try store.resolve(expected.handle, currentOwnerId: current.ownerId, recovering: false)
            bearer = current.accessToken
        }
        let response = try await request(route, bearer: bearer, body: body)
        if route == "cancel", response.cancellationBlocked {
            _ = try store.update(expected) { record in
                guard record.facts.cancelRequested else { throw self.failure("scope_conflict") }
                record.facts.confirmCancellationBlocked = true
            }
            throw failure("request_active")
        }
        let reply = try GuguIOSClosureV2Reply.decode(status: response.status, bytes: response.bytes, route: route)
        let accepted = try store.receive(expected, route: route, backend: transport.backendIdentity, reply: reply)
        if reply.rejectedConfirmation != nil, expected.facts.pendingRoute == "confirm" { throw failure("verification_failed") }
        return accepted
    }
    private func request(_ route: String, bearer: String?, body: [String: Any]?) async throws -> GuguIOSClosureV2HTTP.Reply {
        try await withCheckedThrowingContinuation { completion in
            transport.request(route: route, bearer: bearer, body: body) { completion.resume(with: $0) }
        }
    }
    private func currentSession() throws -> Session {
        guard let current = try session() else { throw failure("unauthorized") }; return current
    }
    private func sameSession(_ expected: Session) throws {
        let current = try currentSession()
        guard current.ownerId == expected.ownerId, current.sessionId == expected.sessionId else { throw failure("scope_conflict") }
    }
    private func binding(_ record: GuguIOSClosureV2Record, recovering: Bool = false) throws -> [String: Any] {
        ["local_operation_id": record.localOperationId, "receipt_token": try store.nativeReceipt(record, recovering: recovering)]
    }
    private func requireOpen(_ record: GuguIOSClosureV2Record) throws {
        guard record.facts.pendingRoute == nil else { throw failure("closure_recovery_required") }
        guard record.facts.state == "open", !record.facts.released else { throw failure("request_active") }
    }
    private nonisolated func failure(_ code: String) -> GuguHostFailure { GuguIOSClosureV2Operation.failure(code) }

    static func snapshot(_ record: GuguIOSClosureV2Record) -> [String: Any] {
        let facts = record.facts
        let phase: String
        if facts.finalized { phase = "finalized" }
        else if facts.cancelled { phase = "cancelled" }
        else if facts.cleanupStep == 5 { phase = "local-complete" }
        else if facts.deleted { phase = "deleted" }
        else if facts.pendingRoute == "cancel" { phase = "cancel-pending" }
        else if facts.state == "processing" { phase = "processing" }
        else if facts.state == "confirming" || facts.pendingRoute == "confirm" { phase = "confirming" }
        else if facts.serverGeneration != nil { phase = "prepared" }
        else if record.checkpoint == "local_prepared" { phase = "local-prepared" }
        else if facts.codeSent { phase = "challenge" }
        else if facts.operationId != nil { phase = "registered" }
        else { phase = "captured" }
        var server: [String: Any]?
        if let id = facts.operationId, let state = facts.state {
            server = ["operationId": id, "state": state, "operationRevision": facts.operationRevision, "challengeGeneration": facts.challengeGeneration]
            if facts.challengeExpiresAt > 0 { server?["challengeExpiresAt"] = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: facts.challengeExpiresAt)) }
        }
        return ["handle": ["localOperationId": record.localOperationId, "nativeGeneration": record.nativeGeneration, "localRevision": record.localRevision],
                "ownerId": record.ownerId, "phase": phase, "serverOperation": server as Any? ?? NSNull(),
                "serverPreparationGeneration": facts.serverGeneration as Any? ?? NSNull(),
                "pendingEffect": facts.pendingRoute as Any? ?? NSNull(), "confirmCancellationBlocked": facts.confirmCancellationBlocked,
                "recoveryOnly": facts.pendingRoute != nil || ["confirming", "processing"].contains(facts.state ?? "") || record.checkpoint == "preparing",
                "agentsPaused": record.checkpoint == "local_prepared" && (!facts.cancelled || facts.resumeRequired),
                "retainedUnattributed": facts.retained]
    }
}
