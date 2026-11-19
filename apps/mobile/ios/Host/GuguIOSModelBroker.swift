import Foundation

/// This value is native memory only. Its token is never a host result, log or
/// durable record. Only the lease ID is kept for checkpoint/revoke recovery.
struct GuguIOSModelGrant: CustomDebugStringConvertible {
    let leaseId: String
    let lease: GuguNativeModelLease
    var debugDescription: String { "GuguIOSModelGrant(<redacted>)" }
}

extension GuguIOSCloudBroker {
    func catalog(binding: GuguIOSHostBinding, includeHidden: Bool = false,
                 completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        modelAccess(binding: binding, body: ["action": "catalog"]) { result in
            completion(result.flatMap { raw in Result {
                guard let object = raw as? [String: Any], let models = object["models"] as? [[String: Any]] else {
                    throw Self.failure("model_protocol_error", "Platform catalog is malformed")
                }
                return models.filter { model in
                    model["enabled"] as? Bool == true && (includeHidden || model["hidden"] as? Bool != true) &&
                    (model["protocols"] as? [String])?.contains("openai-chat-completions") == true
                }
            } })
        }
    }

    func issueModel(binding: GuguIOSHostBinding, agentId: String, sessionId: String, modelId: String,
                    recordLease: @escaping (String) throws -> Void, completion: @escaping (Result<GuguIOSModelGrant, Error>) -> Void) {
        guard UUID(uuidString: agentId) != nil, UUID(uuidString: sessionId) != nil, !modelId.isEmpty else {
            completion(.failure(Self.failure("invalid_args", "Model scope is missing"))); return
        }
        modelAccess(binding: binding, body: ["action": "issue", "agent_user_id": agentId, "engine_id": "pi", "model_id": modelId,
            "protocol": "openai-chat-completions", "provider_session_id": sessionId]) { result in
            switch result {
            case .failure(let error): completion(.failure(error))
            case .success(let raw):
                let value = raw as? [String: Any]
                let leaseId = value?["session_id"] as? String
                do {
                guard let value, let leaseId, UUID(uuidString: leaseId) != nil else {
                    throw Self.failure("invalid_model_lease", "Model issuer returned no lease identity")
                }
                // Capture cleanup custody before parsing any credential-bearing fields.
                try recordLease(leaseId)
                guard value["protocol"] as? String == "openai-chat-completions", let relay = value["relay_url"] as? String,
                      let url = URL(string: relay), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
                      url.query == nil, url.fragment == nil, let token = value["token"] as? String, !token.isEmpty,
                      !token.contains("\r"), !token.contains("\n"), let model = value["model"] as? String, !model.isEmpty,
                      let expiry = value["expires_at"] as? String, let expires = Self.modelExpiry(expiry), expires > Date() else {
                    throw Self.failure("invalid_model_lease", "Model issuer returned an invalid native grant")
                }
                // Existing modelAccess.ts injects relay root + /v1; preserve a
                // gateway path prefix rather than resolving against host root.
                let lease = GuguNativeModelLease(ownerId: binding.ownerId, agentUserId: agentId, sessionId: sessionId, modelId: model,
                    completionsURL: url.appendingPathComponent("v1/chat/completions"), bearerToken: token, expiresAt: expires)
                _ = try GuguModelTransport(lease: lease)
                completion(.success(GuguIOSModelGrant(leaseId: leaseId, lease: lease)))
                } catch {
                    if let leaseId, UUID(uuidString: leaseId) != nil {
                        self.settleModel(binding: binding, leaseId: leaseId, checkpoint: false) { _ in completion(.failure(error)) }
                    } else { completion(.failure(error)) }
                }
            }
        }
    }

    func renewModel(binding: GuguIOSHostBinding, grant: GuguIOSModelGrant,
                    completion: @escaping (Result<GuguIOSModelGrant, Error>) -> Void) {
        modelAccess(binding: binding, body: ["action": "renew", "session_id": grant.leaseId]) { result in
            completion(result.flatMap { raw in Result {
                guard let value = raw as? [String: Any], let expiry = value["expires_at"] as? String,
                      let expires = Self.modelExpiry(expiry), expires > Date(), grant.lease.ownerId == binding.ownerId else {
                    throw Self.failure("invalid_model_lease", "Model renewal did not return a valid expiry")
                }
                let old = grant.lease
                return GuguIOSModelGrant(leaseId: grant.leaseId, lease: GuguNativeModelLease(ownerId: old.ownerId, agentUserId: old.agentUserId,
                    sessionId: old.sessionId, modelId: old.modelId, completionsURL: old.completionsURL, bearerToken: old.bearerToken, expiresAt: expires))
            } })
        }
    }

    func settleModel(binding: GuguIOSHostBinding, leaseId: String, checkpoint: Bool = true,
                     completion: @escaping (Result<Void, Error>) -> Void) {
        guard UUID(uuidString: leaseId) != nil else { completion(.failure(Self.failure("invalid_args", "Invalid model lease ID"))); return }
        let revoke: (Error?) -> Void = { first in
            self.modelAccess(binding: binding, body: ["action": "revoke", "session_id": leaseId]) { result in
                if let first { completion(.failure(first)) }
                else { completion(result.map { _ in () }) }
            }
        }
        if checkpoint {
            modelAccess(binding: binding, body: ["action": "checkpoint", "session_id": leaseId]) { result in
                switch result { case .success: revoke(nil); case .failure(let error): revoke(error) }
            }
        } else { revoke(nil) }
    }

    private static func modelExpiry(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]; return formatter.date(from: value)
    }
}
