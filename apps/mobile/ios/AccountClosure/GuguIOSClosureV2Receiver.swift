import Foundation

/// Constructed only from a fixed-origin native HTTP response, never from a plugin argument.
struct GuguIOSClosureV2Reply {
    let status: Int
    let operationId: String
    let state: String
    let revision: Int64
    let challengeGeneration: Int
    let requestId: String?
    let preparation: Preparation?
    let canRelease: Bool
    let rejectedConfirmation: Confirmation?
    let sentExpiresAt: TimeInterval?
    struct Preparation {
        let nativeGeneration: String
        let serverGeneration: String?
        let prepared: Bool
        let cancelled: Bool
    }
    struct Confirmation {
        let id: String
        let generation: Int
    }
    private struct Envelope: Decodable {
        let error: String?
        let operation: Operation
        let preparation: WirePreparation?
    }
    private struct Operation: Decodable {
        let operation_id: String
        let state: String
        let revision: Int64
        let challenge_generation: Int
        let request_id: String?
        let can_retry: Bool
        let can_release_preparation: Bool?
        let confirmation: WireConfirmation?
    }
    private struct WirePreparation: Decodable {
        let native_generation: String
        let server_generation: String?
        let prepared: Bool?
        let cancelled: Bool?
    }
    private struct WireConfirmation: Decodable {
        let confirmation_id: String
        let state: String
        let challenge_generation: Int
        let error_code: String?
    }
    private struct WireRequest: Decodable {
        let request_id: String
        let state: String
        let expires_at: String
        let last_error: String?
        let can_retry: Bool
    }
    static func decode(status: Int, bytes: Data, route: String) throws -> Self {
        try GuguIOSClosureV2HTTP.Reply(status: status, bytes: bytes).requireSuccess(allowDefinitiveRejection: route == "confirm")
        guard bytes.count <= 65536, let root = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let rawOperation = root["operation"] as? [String: Any], rawOperation.keys.contains("request_id"),
              let response = try? JSONDecoder().decode(Envelope.self, from: bytes) else { throw failure() }
        let operation = response.operation
        guard canonical(operation.operation_id), operation.request_id.map(canonical) ?? true,
              ["open", "confirming", "processing", "deleted", "closed_before_confirm"].contains(operation.state),
              (1...9_007_199_254_740_991).contains(operation.revision),
              (0...Int(Int32.max)).contains(operation.challenge_generation), !operation.can_retry else { throw failure() }
        let canRelease = operation.can_release_preparation == true
        guard !canRelease || operation.state == "closed_before_confirm" else { throw failure() }
        var sentExpiresAt: TimeInterval?
        if let rawRequest = rawOperation["request"] as? [String: Any], rawRequest.keys.contains("last_error"),
           let data = try? JSONSerialization.data(withJSONObject: rawRequest), let request = try? JSONDecoder().decode(WireRequest.self, from: data),
           request.request_id == operation.request_id, request.state == "challenge", request.last_error == nil {
            let fraction = ISO8601DateFormatter(); fraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter(); plain.formatOptions = [.withInternetDateTime]
            if let date = fraction.date(from: request.expires_at) ?? plain.date(from: request.expires_at), date.timeIntervalSince1970 > 0 {
                sentExpiresAt = date.timeIntervalSince1970
            }
        }
        let rejected: Confirmation?
        if operation.state == "open", ["confirm", "result"].contains(route), let confirmation = operation.confirmation, confirmation.state == "rejected" {
            guard canonical(confirmation.confirmation_id), (1...Int(Int32.max)).contains(confirmation.challenge_generation),
                  confirmation.error_code == "verification_failed" else { throw failure() }
            rejected = .init(id: confirmation.confirmation_id, generation: confirmation.challenge_generation)
        } else { rejected = nil }
        guard [200, 201, 202].contains(status) || (status == 422 && route == "confirm"
            && response.error == "verification_failed" && rejected != nil) else { throw failure() }
        let preparation: Preparation?
        if let supplied = response.preparation {
            guard let raw = root["preparation"] as? [String: Any], raw.keys.contains("server_generation"),
                  canonical(supplied.native_generation), supplied.server_generation.map(canonical) ?? true else { throw failure() }
            let prepared: Bool, cancelled: Bool
            if route == "prepare_device" {
                guard supplied.prepared == true, supplied.cancelled != true else { throw failure() }
                prepared = true; cancelled = false
            } else if route == "cancel" || (canRelease && operation.state == "closed_before_confirm" && supplied.cancelled == true && supplied.prepared == nil) {
                guard supplied.cancelled == true, supplied.prepared != true else { throw failure() }
                prepared = false; cancelled = true
            } else {
                guard let p = supplied.prepared, let c = supplied.cancelled else { throw failure() }
                prepared = p; cancelled = c
            }
            guard prepared != cancelled, !prepared || supplied.server_generation != nil else { throw failure() }
            preparation = .init(nativeGeneration: supplied.native_generation, serverGeneration: supplied.server_generation,
                                prepared: prepared, cancelled: cancelled)
        } else { preparation = nil }
        return .init(status: status, operationId: operation.operation_id, state: operation.state, revision: operation.revision,
                     challengeGeneration: operation.challenge_generation, requestId: operation.request_id,
                     preparation: preparation, canRelease: canRelease, rejectedConfirmation: rejected, sentExpiresAt: sentExpiresAt)
    }
    private static func canonical(_ id: String) -> Bool { UUID(uuidString: id)?.uuidString.lowercased() == id }
    private static func failure() -> GuguHostFailure { GuguIOSClosureV2Operation.failure("closure_unavailable") }
}

extension GuguIOSClosureV2Operation {
    func receive(_ expected: GuguIOSClosureV2Record, route: String, backend: String,
                 reply: GuguIOSClosureV2Reply) throws -> GuguIOSClosureV2Record {
        let prior = expected.facts
        guard expected.backend == backend, prior.operationId == nil || prior.operationId == reply.operationId,
              reply.revision >= prior.operationRevision, reply.challengeGeneration >= prior.challengeGeneration,
              route == "result" || prior.pendingRoute == route || (route == "cancel" && prior.cancelRequested && prior.pendingRoute == "confirm"),
              prior.state != "deleted" || reply.state == "deleted",
              prior.state != "closed_before_confirm" || reply.state == "closed_before_confirm" else { throw Self.failure("scope_conflict") }
        if prior.operationId != nil, reply.revision == prior.operationRevision {
            guard prior.state == reply.state, prior.challengeGeneration == reply.challengeGeneration,
                  prior.requestId == reply.requestId else { throw Self.failure("scope_conflict") }
        }
        if let preparation = reply.preparation {
            guard preparation.nativeGeneration == expected.nativeGeneration,
                  prior.serverGeneration == nil || prior.serverGeneration == preparation.serverGeneration else { throw Self.failure("scope_conflict") }
            if preparation.cancelled {
                guard reply.state == "closed_before_confirm", reply.canRelease else { throw Self.failure("closure_recovery_required") }
            }
        }
        let acceptsRejection = prior.pendingRoute == "confirm" && reply.rejectedConfirmation != nil
        if acceptsRejection, let rejection = reply.rejectedConfirmation {
            guard prior.operationId != nil, ["confirm", "result"].contains(route), prior.confirmationId == rejection.id,
                  prior.challengeGeneration == rejection.generation, prior.challengeGeneration == reply.challengeGeneration else {
                throw Self.failure("scope_conflict")
            }
        }
        return try update(expected, recovering: route == "result") { record in
            record.facts.operationId = reply.operationId; record.facts.state = reply.state
            record.facts.operationRevision = reply.revision; record.facts.challengeGeneration = reply.challengeGeneration
            record.facts.requestId = reply.requestId
            if let preparation = reply.preparation { record.facts.serverGeneration = preparation.serverGeneration }
            if route == "register" || (route == "result" && record.facts.pendingRoute == "register") { record.facts.pendingRoute = nil }
            if record.facts.pendingRoute == "challenge", ["challenge", "result"].contains(route), reply.state == "open",
               let expiresAt = reply.sentExpiresAt, reply.challengeGeneration == record.facts.attemptedChallengeGeneration {
                record.facts.codeSent = true; record.facts.challengeExpiresAt = expiresAt; record.facts.pendingRoute = nil
            }
            if reply.preparation?.prepared == true, record.facts.pendingRoute == "prepare_device" { record.facts.pendingRoute = nil }
            if reply.preparation?.cancelled == true { record.facts.cancelled = true; record.facts.pendingRoute = nil }
            if reply.state == "deleted" { record.facts.pendingRoute = nil }
            if acceptsRejection { record.facts.confirmationRejected = true; record.facts.pendingRoute = nil }
            if reply.preparation?.cancelled == true || reply.state == "deleted" || acceptsRejection {
                record.facts.cancelRequested = false; record.facts.confirmCancellationBlocked = false
            }
            // Neither open nor a bare HTTP error is a new confirmation or a release permit.
        }
    }
}
