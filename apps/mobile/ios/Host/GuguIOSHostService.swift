import Foundation

/// One App-owned facade. Native root, credentials, endpoints, lifecycle and tool
/// executor are constructor dependencies; none can be selected by WebView input.
final class GuguIOSHostService {
    private final class RemoteRouter {
        weak var adapter: GuguIOSHostAdapter?
        func invoke(_ expected: GuguIOSHostBinding, _ channel: String, _ args: [Any], _ id: String, _ done: @escaping ([String: Any]) -> Void) {
            guard let adapter else { done(GuguIOSNativeBackend.replyError(GuguIOSNativeBackend.failure("host_not_ready", "Native service is unavailable"), admission: "rejected")); return }
            adapter.hostCall(ownerId: expected.ownerId, id: id, channel: channel, args: args, origin: .remoteAgent, expectedBinding: expected, completion: done)
        }
    }
    private final class StateEvents {
        private let lock = NSLock()
        private var listener: (([String: Any]) -> Void)?
        func observe(_ value: @escaping ([String: Any]) -> Void) { lock.lock(); defer { lock.unlock() }; listener = value }
        func emit(_ value: [String: Any]) { lock.lock(); let callback = listener; lock.unlock(); callback?(value) }
    }
    let backend: GuguIOSNativeBackend
    let adapter: GuguIOSHostAdapter
    private let ownerAccess: GuguIOSOwnerAccess
    private let metadata: () -> [String: Any]
    private let retirementCleanup: GuguIOSRetirementCleanup?
    private let retirementAuthorization: GuguIOSRetirementCleanup.Authorize?
    private let events = StateEvents()

    init(root: URL, runtime: GuguPackagedRuntime, lifecycle: GuguIOSHostLifecycle, ownerAccess: GuguIOSOwnerAccess,
         configuration: GuguIOSBackendConfiguration, credentials: @escaping GuguIOSCloudBroker.Credentials,
         executor: @escaping (GuguIOSHostBinding) -> GuguNativeToolExecutor, deviceMetadata: @escaping () -> [String: Any],
         brokerSend: GuguIOSCloudBroker.Send? = nil, socketFactory: GuguIOSRealtimeTransport.SocketFactory? = nil,
         modelTransport: @escaping (GuguNativeModelLease) throws -> GuguModelCompleting = { try GuguModelTransport(lease: $0) },
         retirementAuthorization: GuguIOSRetirementCleanup.Authorize? = nil) throws {
        self.retirementAuthorization = retirementAuthorization
        retirementCleanup = try retirementAuthorization.map { try GuguIOSRetirementCleanup(root: root, configuration: configuration, authorize: $0, send: brokerSend) }
        self.ownerAccess = ownerAccess; metadata = deviceMetadata
        let router = RemoteRouter(), events = self.events
        backend = try GuguIOSNativeBackend(root: root, runtime: runtime, lifecycle: lifecycle, ownerAccess: ownerAccess,
            configuration: configuration, credentials: credentials, executor: executor,
            remoteInvoke: { expected, channel, args, id, done in router.invoke(expected, channel, args, id, done) },
            event: { events.emit($0) }, brokerSend: brokerSend, socketFactory: socketFactory, modelTransport: modelTransport)
        adapter = GuguIOSHostAdapter(root: root.appendingPathComponent("host-calls"), backend: backend,
            currentIdentity: { try? ownerAccess.ownerBinding() }, requireOwnerUI: { try ownerAccess.requireLocalOwnerUI() })
        router.adapter = adapter
    }
    func observeState(_ listener: @escaping ([String: Any]) -> Void) { events.observe(listener) }
    func configure(_ options: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        do {
            try Self.keys(options, allowed: ["expectedBinding", "device"])
            guard let raw = options["expectedBinding"] as? [String: Any] else { throw Self.failure("invalid_args", "Current native binding is required") }
            try Self.keys(raw, allowed: ["ownerId", "deviceId", "installationId"])
            guard let owner = raw["ownerId"] as? String, let device = raw["deviceId"] as? String, let install = raw["installationId"] as? String else { throw Self.failure("invalid_args", "Native binding is incomplete") }
            let expected = GuguIOSHostBinding(ownerId: owner, deviceId: device, installationId: install)
            try expected.validate()
            guard try ownerAccess.ownerBinding() == expected else { throw Self.failure("stale_context", "Native publication changed") }
            var deviceMetadata = metadata()
            if let display = options["device"] {
                guard let display = display as? [String: Any] else { throw Self.failure("invalid_args", "Device display options must be an object") }
                try Self.keys(display, allowed: ["label"])
                if let label = display["label"] {
                    guard let label = label as? String, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.utf8.count <= 256 else { throw Self.failure("invalid_args", "Device label is invalid") }
                    deviceMetadata["label"] = label
                }
            }
            // The backend/executor observes ownerAccess. JS cannot publish grants.
            adapter.configure(.init(binding: expected, grants: [:], deviceMetadata: deviceMetadata), completion: completion)
        } catch { completion(GuguIOSNativeBackend.replyError(error, admission: "rejected")) }
    }
    func hostState(_ options: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        do {
            try Self.keys(options, allowed: ["expectedBinding"])
            let expected = try Self.expected(options)
            guard try ownerAccess.ownerBinding() == expected else { throw Self.failure("stale_context", "Original native state binding changed") }
            adapter.hostState(expectedBinding: expected, completion: completion)
        }
        catch { completion(GuguIOSNativeBackend.replyError(error, admission: "rejected")) }
    }
    func hostCall(_ options: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        do {
            try Self.keys(options, allowed: ["expectedBinding", "id", "channel", "args"])
            let expected = try Self.expected(options)
            guard let id = options["id"] as? String, let channel = options["channel"] as? String, let args = options["args"] as? [Any] else { throw Self.failure("invalid_args", "Original host-call ID, channel and arguments are required") }
            guard try ownerAccess.ownerBinding() == expected else { throw Self.failure("stale_context", "Original native host-call binding changed") }
            adapter.hostCall(ownerId: expected.ownerId, id: id, channel: channel, args: args, origin: .localOwnerUI, expectedBinding: expected, completion: completion)
        } catch { completion(GuguIOSNativeBackend.replyError(error, admission: "rejected")) }
    }
    func stopHost(_ options: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        do {
            try Self.keys(options, allowed: ["expectedBinding"])
            let expected = try Self.expected(options)
            guard try ownerAccess.ownerBinding() == expected else { throw Self.failure("stale_context", "Original native stop binding changed") }
            adapter.stopHost(expectedBinding: expected, completion: completion)
        }
        catch { completion(GuguIOSNativeBackend.replyError(error, admission: "rejected")) }
    }
    /// Run while the original native credential publication is still available.
    /// Completion includes model checkpoint/revoke and device withdrawal errors.
    func prepareOwnerRetirement(expectedBinding: GuguIOSHostBinding, completion: @escaping ([String: Any]) -> Void) { adapter.stopHost(expectedBinding: expectedBinding, completion: completion) }
    /// Native-only sealed/cold path. It never calls ownerAccess/currentBinding
    /// and never lends its permit to ordinary catalog/issue/hostCall requests.
    func retireOwner(expectedBinding: GuguIOSHostBinding, retirementId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            guard let retirementCleanup, let retirementAuthorization else { throw Self.failure("cleanup_not_configured", "Native retirement authorization was not assembled") }
            _ = try GuguIOSRetirementHTTP.permit(retirementAuthorization, binding: expectedBinding, retirementId: retirementId, operation: .readOwnedDevice)
            adapter.invalidateForRetirement(expectedBinding: expectedBinding) { invalidated in
                do { try invalidated.get() } catch { completion(.failure(error)); return }
                self.backend.quiesceForRetirement(expectedBinding) { local in
                    retirementCleanup.retire(expectedBinding: expectedBinding, retirementId: retirementId) { cleanup in
                        if case .failure = local { completion(local) } else { completion(cleanup) }
                    }
                }
            }
        } catch { completion(.failure(error)) }
    }
    func authSession(_ options: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        do {
            try Self.keys(options, allowed: ["action"])
            guard let action = options["action"] as? String else { throw Self.failure("invalid_args", "Auth delegation action is required") }
            adapter.authSession(action: action, completion: completion)
        } catch { completion(.failure(error)) }
    }
    private static func expected(_ options: [String: Any]) throws -> GuguIOSHostBinding {
        guard let raw = options["expectedBinding"] as? [String: Any] else { throw failure("invalid_args", "Original native binding is required") }
        try keys(raw, allowed: ["ownerId", "deviceId", "installationId"])
        guard let owner = raw["ownerId"] as? String, let device = raw["deviceId"] as? String, let installation = raw["installationId"] as? String else { throw failure("invalid_args", "Original native binding is incomplete") }
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: device, installationId: installation)
        try binding.validate(); return binding
    }
    private static func keys(_ options: [String: Any], allowed: Set<String>) throws {
        // Validate names before reading values: legacy auth/URL objects are never retained.
        guard Set(options.keys).isSubset(of: allowed) else { throw failure("invalid_args", "Unsupported native host field") }
    }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { .init(code: code, message: text) }
}
