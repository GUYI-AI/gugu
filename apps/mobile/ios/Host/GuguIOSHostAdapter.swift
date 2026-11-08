import Foundation

/// Auth is explicitly delegated to the existing shared coordinator. All mutating
/// calls retain their original UUID and durable backend custody before acknowledgement.
final class GuguIOSHostAdapter {
    private let queue = DispatchQueue(label: "app.gugu.ios.host-adapter")
    private let root: URL
    private let backend: GuguIOSHostBackend
    private let currentIdentity: () -> GuguIOSHostBinding?
    private let requireOwnerUI: () throws -> Void
    private var configured: GuguIOSHostBinding?
    private var store: GuguHostCallStore?
    private var generation = 0
    private var configurationSequence = 0
    private var configuringBinding: GuguIOSHostBinding?
    private var retiringBinding: GuguIOSHostBinding?
    private var inFlight: Set<String> = []

    private static let reads: Set<String> = [
        "sessionTimeline.sessionsList", "sessionTimeline.sessionOfAgent", "sessionTimeline.sessionCreateOptions",
        "sessionTimeline.sessionCreateModels", "sessionTimeline.sessionSnapshot", "sessionTimeline.sessionAfter",
        "sessionTimeline.sessionOlder", "sessionTimeline.sessionToolImage", "sessionTimeline.sessionOptions",
        "appSettings.get", "appSettings.getWithMeta",
    ]
    private static let mutations: Set<String> = [
        "sessionTimeline.sessionCreate", "sessionTimeline.sessionSend", "sessionTimeline.sessionRespond",
        "sessionTimeline.sessionQueue", "sessionTimeline.sessionCancel", "sessionTimeline.sessionSetOption",
        "sessionTimeline.sessionReloadModel", "sessionTimeline.prefetchFiles", "sessions.markSessionSeen",
        "appSettings.update",
    ]

    init(root: URL, backend: GuguIOSHostBackend,
         currentIdentity: @escaping () -> GuguIOSHostBinding?, requireOwnerUI: @escaping () throws -> Void) {
        self.root = root; self.backend = backend
        self.currentIdentity = currentIdentity; self.requireOwnerUI = requireOwnerUI
    }

    /// Capacitor passes only action. Do not read/retain its legacy refreshToken field.
    func authSession(action: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        queue.async {
            guard ["get", "refresh", "sign_out"].contains(action) else {
                completion(.failure(Self.failure("invalid_args", "Unsupported auth delegation action"))); return
            }
            let delegated: [String: Any] = ["available": false, "session": NSNull()]
            guard action == "sign_out", let binding = self.configured ?? self.configuringBinding ?? self.retiringBinding else { completion(.success(delegated)); return }
            self.retire(binding) { error in
                if let error { completion(.failure(error)) } else { completion(.success(delegated)) }
            }
        }
    }

    func configure(_ configuration: GuguIOSHostConfiguration, completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            do {
                try self.check(configuration.binding)
                try Self.rejectCredentialFields(configuration.deviceMetadata)
                let configure = {
                    self.configurationSequence += 1
                    let sequence = self.configurationSequence
                    self.configuringBinding = configuration.binding
                    self.backend.configure(configuration) { state in
                        self.queue.async {
                            do {
                                try self.check(configuration.binding)
                                guard self.configurationSequence == sequence else { throw Self.failure("stale_context", "Configuration was superseded") }
                                try Self.validateState(state, binding: configuration.binding)
                                if self.store == nil { self.store = try GuguHostCallStore(root: self.root, binding: configuration.binding) }
                                self.configuringBinding = nil
                                self.configured = configuration.binding
                                completion(state)
                            } catch { completion(Self.envelope(error)) }
                        }
                    }
                }
                if let prior = self.configured ?? self.configuringBinding ?? self.retiringBinding, prior != configuration.binding || self.retiringBinding != nil {
                    self.retire(prior) { error in
                        if let error { completion(Self.envelope(error)) } else { configure() }
                    }
                } else { configure() }
            } catch { completion(Self.envelope(error)) }
        }
    }

    func hostState(ownerId: String, completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            do {
                guard let binding = self.currentIdentity(), binding.ownerId == ownerId else { throw Self.failure("stale_context", "Current owner is unavailable") }
                try self.check(binding)
                guard self.configured == binding else { throw Self.failure("host_not_ready", "Native host is not configured") }
                let state = try self.backend.state(binding: binding)
                try Self.validateState(state, binding: binding)
                completion(state)
            } catch { completion(Self.envelope(error)) }
        }
    }

    func hostCall(ownerId: String, id: String, channel: String, args: [Any], origin: GuguIOSHostCallOrigin, expectedBinding: GuguIOSHostBinding? = nil,
                  completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            var custodyAttempted = false
            do {
                guard UUID(uuidString: id) != nil else { throw Self.failure("invalid_args", "Host call requires the original UUID") }
                guard Self.reads.contains(channel) || Self.mutations.contains(channel) else { throw Self.failure("unknown_method", "Host channel is not implemented") }
                guard let binding = self.configured, binding.ownerId == ownerId, let store = self.store else { throw Self.failure("host_not_ready", "Native host is not configured") }
                guard expectedBinding == nil || binding == expectedBinding else { throw Self.failure("stale_context", "Original host-call binding was retired") }
                try self.check(binding)
                try Self.rejectCredentialFields(args)
                let settings = channel.hasPrefix("appSettings.")
                if settings {
                    guard origin == .localOwnerUI else { throw Self.failure("not_granted", "Phone settings require the local owner surface") }
                    if channel == "appSettings.update" { try self.requireOwnerUI() }
                }
                if channel == "sessionTimeline.sessionRespond" {
                    guard origin == .localOwnerUI else { throw Self.failure("not_granted", "Permission decisions require the local owner UI") }
                    try self.requireOwnerUI()
                }
                let state = try self.backend.state(binding: binding)
                try Self.validateState(state, binding: binding)
                guard settings || state["ready"] as? Bool == true else { throw Self.failure("host_not_ready", "Native task host is not ready") }
                let call = GuguIOSHostInvocation(binding: binding, requestId: id, channel: channel, arguments: args, origin: origin)
                let callGeneration = self.generation
                if Self.reads.contains(channel) {
                    self.backend.invoke(call) { reply in self.queue.async {
                        do { try self.checkGeneration(callGeneration, binding); try Self.validateReply(reply); completion(reply) }
                        catch { completion(Self.envelope(error)) }
                    } }
                    return
                }
                custodyAttempted = true
                let prior = try store.admit(call)
                if prior["status"] as? String == "completed" {
                    try self.backend.authorizeReplay(call)
                    guard let saved = prior["reply"] as? [String: Any] else { throw Self.failure("invalid_journal", "Host-call receipt is missing") }
                    completion(saved); return
                }
                let flightKey = "\(callGeneration):\(id)"
                guard !self.inFlight.contains(flightKey) else {
                    completion(Self.error("admission_uncertain", "Original host call is still in flight", admission: "uncertain")); return
                }
                let callback: ([String: Any]) -> Void = { reply in self.queue.async {
                    guard self.inFlight.remove(flightKey) != nil else { return }
                    do {
                        try Self.validateReply(reply)
                        // Preserve a known old-owner receipt before rejecting its late delivery.
                        try store.finish(call, reply: reply)
                        try self.checkGeneration(callGeneration, binding)
                        try self.backend.authorizeReplay(call)
                        completion(reply)
                    } catch { completion(Self.envelope(error, admission: "uncertain")) }
                } }
                if prior["status"] as? String == "admitted" {
                    try store.begin(call)
                    self.inFlight.insert(flightKey)
                    self.backend.invoke(call, completion: callback)
                } else {
                    self.inFlight.insert(flightKey)
                    self.backend.reconcile(call, completion: callback)
                }
            } catch { completion(Self.envelope(error, admission: custodyAttempted ? "uncertain" : "rejected")) }
        }
    }

    func stopHost(ownerId: String, completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard let binding = self.configured ?? self.configuringBinding ?? self.retiringBinding else { completion([:]); return }
            guard binding.ownerId == ownerId else { completion(Self.error("stale_context", "Cannot stop another native owner", admission: "rejected")); return }
            self.retire(binding) { error in completion(error.map { Self.envelope($0) } ?? [:]) }
        }
    }

    private func retire(_ binding: GuguIOSHostBinding, completion: @escaping (Error?) -> Void) {
        generation += 1
        configurationSequence += 1
        configured = nil; configuringBinding = nil; store = nil
        retiringBinding = binding
        backend.stop(binding: binding) { error in self.queue.async {
            if error == nil, self.retiringBinding == binding { self.retiringBinding = nil }
            completion(error)
        } }
    }
    private func check(_ binding: GuguIOSHostBinding) throws {
        try binding.validate()
        guard currentIdentity() == binding else { throw Self.failure("stale_context", "Owner, device or native installation changed") }
    }
    private func checkGeneration(_ expected: Int, _ binding: GuguIOSHostBinding) throws {
        try check(binding)
        guard generation == expected, configured == binding else { throw Self.failure("stale_context", "Native host was retired before reply") }
    }
    private static func validateState(_ state: [String: Any], binding: GuguIOSHostBinding) throws {
        guard state["ownerId"] as? String == binding.ownerId, state["deviceId"] as? String == binding.deviceId,
              let status = state["status"] as? String, let ready = state["ready"] as? Bool,
              ["starting", "ready", "failed", "stopped", "interrupted"].contains(status),
              !ready || status == "ready" else { throw failure("invalid_backend_state", "Backend did not provide a bound native host state") }
    }
    private static func validateReply(_ reply: [String: Any]) throws {
        guard reply.keys.contains("result") != (reply["error"] is [String: Any]) else { throw failure("invalid_backend_reply", "Expected host result or structured error") }
        try rejectCredentialFields(reply)
    }
    private static func rejectCredentialFields(_ value: Any) throws {
        if let object = value as? [String: Any] {
            for (key, item) in object {
                if ["refreshToken", "refresh_token", "accessToken", "access_token", "apiKey", "api_key", "Authorization"].contains(key) {
                    throw failure("invalid_args", "Credential fields are not part of this host-call contract")
                }
                try rejectCredentialFields(item)
            }
        } else if let array = value as? [Any] { for item in array { try rejectCredentialFields(item) } }
    }
    private static func failure(_ code: String, _ message: String) -> GuguHostFailure { GuguHostFailure(code: code, message: message) }
    private static func error(_ code: String, _ message: String, admission: String) -> [String: Any] {
        ["error": ["code": code, "message": message, "admission": admission]]
    }
    private static func envelope(_ error: Error, admission: String = "rejected") -> [String: Any] {
        let failure = error as? GuguHostFailure ?? GuguHostFailure(code: "host_failed", message: "Native host operation failed")
        return self.error(failure.code, failure.message, admission: admission)
    }
}
