import Foundation

/// Concrete native owner of broker, task registry, foreground Pi and private
/// channels. Construction alone registers no capability and sends no request.
final class GuguIOSNativeBackend: GuguIOSHostBackend {
    typealias RemoteInvoke = (GuguIOSHostBinding, String, [Any], String, @escaping ([String: Any]) -> Void) -> Void
    private final class EpochGate {
        private let lock = NSLock()
        private var epoch: UInt64 = 0
        private var active = false
        func set(_ value: UInt64, active: Bool) { lock.lock(); defer { lock.unlock() }; epoch = value; self.active = active }
        func require(_ value: UInt64) throws {
            lock.lock(); defer { lock.unlock() }
            guard active, epoch == value else { throw GuguIOSNativeBackend.failure("stale_context", "Native backend was retired") }
        }
    }
    private let gate = EpochGate()
    let queue = DispatchQueue(label: "app.gugu.ios.native-backend")
    let queueKey = DispatchSpecificKey<Bool>()
    let root: URL
    let runtime: GuguPackagedRuntime
    let lifecycle: GuguIOSHostLifecycle
    let ownerAccess: GuguIOSOwnerAccess
    let endpoint: GuguIOSBackendConfiguration
    let credentials: GuguIOSCloudBroker.Credentials
    let broker: GuguIOSCloudBroker
    let executorFactory: (GuguIOSHostBinding) -> GuguNativeToolExecutor
    let modelTransport: (GuguNativeModelLease) throws -> GuguModelCompleting
    let socketFactory: GuguIOSRealtimeTransport.SocketFactory?
    let remoteInvoke: RemoteInvoke
    let emit: ([String: Any]) -> Void
    let instanceId = UUID().uuidString.lowercased()
    // Pinned to core/cloud/serverMachineHealth.ts; author contract checks must
    // compare both values when the existing shared protocol changes.
    let remoteProtocol = 18, minimumClientProtocol = 17
    var binding: GuguIOSHostBinding?
    var store: GuguIOSBackendStore?
    var sources: GuguIOSSourceAccess?
    var scheduler: GuguIOSTaskScheduler?
    var provisioner: GuguIOSProvisioner?
    var createCommand: GuguIOSCreateCommand?
    var deliveryCommand: GuguIOSDeliveryCommand?
    var inbox: GuguIOSInboxPump?
    var remote: GuguIOSRealtimeHost?
    var proof: GuguJavaScriptRuntime?
    var metadata: [String: Any] = [:]
    var generation: UInt64 = 0
    var stopped = true, startupComplete = false, remoteConnected = false, heartbeatHealthy = false
    var heartbeatAt: Date?, healthError: Error?, heartbeatError: Error?, commandError: Error?
    var heartbeatRunning = false, heartbeatWaiters: [() -> Void] = []
    var heartbeatTimer: DispatchWorkItem?
    var commandRunning = false, recoveredCommands = false
    var inboxRunning = false, inboxHealthy = false
    var inboxError: Error?
    var stopping: [(Error?) -> Void] = []
    // Readiness requires the installed text-delivery adapter and an actual
    // successful inbox reconciliation, independently of HTTP/Realtime probes.
    var missingDelivery: Error? {
        guard inbox != nil else { return Self.failure("delivery_not_connected", "Native inbox delivery is not configured") }
        return inboxHealthy ? nil : inboxError ?? Self.failure("delivery_reconciling", "Native inbox delivery has not reconciled")
    }

    init(root: URL, runtime: GuguPackagedRuntime, lifecycle: GuguIOSHostLifecycle, ownerAccess: GuguIOSOwnerAccess,
         configuration: GuguIOSBackendConfiguration, credentials: @escaping GuguIOSCloudBroker.Credentials,
         executor: @escaping (GuguIOSHostBinding) -> GuguNativeToolExecutor,
         remoteInvoke: @escaping RemoteInvoke, event: @escaping ([String: Any]) -> Void,
         brokerSend: GuguIOSCloudBroker.Send? = nil, socketFactory: GuguIOSRealtimeTransport.SocketFactory? = nil,
         modelTransport: @escaping (GuguNativeModelLease) throws -> GuguModelCompleting = { try GuguModelTransport(lease: $0) }) throws {
        self.root = root.resolvingSymlinksInPath().standardizedFileURL; self.runtime = runtime; self.lifecycle = lifecycle; self.ownerAccess = ownerAccess
        endpoint = configuration; self.credentials = credentials; executorFactory = executor; self.remoteInvoke = remoteInvoke; emit = event
        self.socketFactory = socketFactory; self.modelTransport = modelTransport
        broker = try GuguIOSCloudBroker(configuration: configuration, credentials: credentials, send: brokerSend)
        queue.setSpecific(key: queueKey, value: true)
    }

    func configure(_ configuration: GuguIOSHostConfiguration, completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            do {
                try self.check(configuration.binding)
                if let current = self.binding, current != configuration.binding, !self.stopped || self.healthError != nil { throw Self.failure("host_stopping", "Previous native owner must retire before configuration") }
                guard let label = configuration.deviceMetadata["label"] as? String, !label.isEmpty,
                      configuration.deviceMetadata["hostname"] is String, configuration.deviceMetadata["osName"] is String,
                      configuration.deviceMetadata["tier"] is String else { throw Self.failure("invalid_args", "Native device metadata is incomplete") }
                try GuguIOSCloudBroker.rejectCredentials(configuration.deviceMetadata)
                if self.binding == configuration.binding, !self.stopped {
                    self.metadata = configuration.deviceMetadata; self.heartbeat(); completion(try self.snapshot(configuration.binding)); return
                }
                self.generation &+= 1; let epoch = self.generation
                self.gate.set(epoch, active: true)
                self.binding = configuration.binding; self.metadata = configuration.deviceMetadata
                self.stopped = false; self.startupComplete = false; self.remoteConnected = false; self.heartbeatHealthy = false; self.healthError = nil; self.heartbeatError = nil; self.commandError = nil; self.recoveredCommands = false
                self.inboxHealthy = false; self.inboxError = nil; self.inboxRunning = false; self.commandRunning = false
                try self.lifecycle.activate(binding: configuration.binding)
                let store = try GuguIOSBackendStore(root: self.root.appendingPathComponent("backend"), binding: configuration.binding); self.store = store
                let proof = try GuguJavaScriptRuntime(asset: self.runtime.asset, expectedSHA256: self.runtime.sha256,
                    request: { _, reply in reply(Self.failure("unknown_method", "Runtime proof does not execute tasks").envelope) }, cancel: { _ in }, event: { _ in })
                let diagnostics = try proof.diagnostics()
                guard diagnostics["piVersion"] as? String == "1.4.0", diagnostics["engine"] as? String == "JavaScriptCore", diagnostics["node"] as? Bool == false,
                      diagnostics["communicationTools"] as? [String] == ["profile_whoami", "message_conversations", "message_rules", "message_members", "message_history", "message_send"] else { throw Self.failure("runtime_not_ready", "Packaged native Pi and communication tools did not verify") }
                self.proof = proof
                let check = { try self.gate.require(epoch); try self.check(configuration.binding); try self.gate.require(epoch) }
                let sources = GuguIOSSourceAccess(store: store, broker: self.broker, check: check); self.sources = sources
                let scheduler = try GuguIOSTaskScheduler.open(store: store, lifecycle: self.lifecycle, runtime: self.runtime, broker: self.broker, check: check,
                    executor: { self.executorFactory(configuration.binding) }, changed: { self.queue.async { self.publish() } }, sourceAuthorization: { context, done in sources.authorize(context, completion: done) }, modelTransport: self.modelTransport); self.scheduler = scheduler
                let inbox = GuguIOSInboxPump(store: store, broker: self.broker, sources: sources, runtime: proof, scheduler: scheduler, check: check)
                self.inbox = inbox
                self.deliveryCommand = GuguIOSDeliveryCommand(store: store, broker: self.broker, pump: inbox, instanceId: self.instanceId, check: check)
                let create = GuguIOSCreateCommand(broker: self.broker, store: store, instanceId: self.instanceId, projectPath: self.workspacePath,
                    check: check, start: { agent, done in scheduler.establish(agent, completion: done) }); self.createCommand = create
                self.provisioner = try GuguIOSProvisioner(store: store, broker: self.broker, projectPath: self.workspacePath, check: check,
                    executeCreate: { id, done in create.execute(id: id, completion: done) }, admit: { agent, text, id, done in scheduler.admit(agent: agent, text: text, id: id, completion: done) })
                let transport: GuguIOSRealtimeTransport
                if let factory = self.socketFactory { transport = try GuguIOSRealtimeTransport(configuration: self.endpoint, binding: configuration.binding, credentials: self.credentials, makeSocket: factory) }
                else { transport = try GuguIOSRealtimeTransport(configuration: self.endpoint, binding: configuration.binding, credentials: self.credentials) }
                self.remote = GuguIOSRealtimeHost(binding: configuration.binding, transport: transport, protocolVersion: self.remoteProtocol, minimumProtocol: self.minimumClientProtocol,
                    check: check, invoke: { channel, args, id, done in self.remoteInvoke(configuration.binding, channel, args, id, done) }, command: { self.queue.async { self.commandTick() } }, connectivity: { value in self.queue.async {
                        guard self.generation == epoch, !self.stopped else { return }; self.remoteConnected = value
                        if value { self.heartbeat() }; self.publish()
                    } })
                self.recoverLeases(configuration.binding) { result in self.queue.async {
                    guard self.generation == epoch, !self.stopped else { completion(Self.errorState(configuration.binding, Self.failure("stale_context", "Configuration was retired"))); return }
                    do {
                        _ = try result.get(); try self.check(configuration.binding)
                        self.startupComplete = true; self.remote?.open(); self.heartbeat(); self.armHeartbeat()
                        completion(try self.snapshot(configuration.binding)); self.publish()
                    } catch { self.healthError = error; completion(Self.errorState(configuration.binding, error)); self.publish() }
                } }
            } catch {
                if (try? self.ownerAccess.ownerBinding()) == configuration.binding { self.healthError = error; self.publish() }
                completion(Self.errorState(configuration.binding, error))
            }
        }
    }
    func sealForNativeRetirement() {
        stopped = true; generation &+= 1; gate.set(generation, active: false)
        heartbeatTimer?.cancel(); remoteConnected = false; startupComplete = false
    }
    func state(binding: GuguIOSHostBinding) throws -> [String: Any] { try sync { try snapshot(binding) } }
    func invoke(_ call: GuguIOSHostInvocation, completion: @escaping ([String: Any]) -> Void) { queue.async { self.route(call, completion) } }
    func reconcile(_ call: GuguIOSHostInvocation, completion: @escaping ([String: Any]) -> Void) { queue.async { self.route(call, completion) } }
    func authorizeReplay(_ call: GuguIOSHostInvocation) throws {
        try sync {
            try check(call.binding)
            if call.channel == "sessionTimeline.sessionRespond", let input = call.arguments.first as? [String: Any], let id = input["conversationId"] as? String {
                try schedulerOrThrow().authorize(agent: agent(id))
            }
        }
    }
    func stop(binding expected: GuguIOSHostBinding, completion: @escaping (Error?) -> Void) {
        queue.async {
            guard self.binding == expected else { completion(Self.failure("stale_context", "Native backend belongs to another owner")); return }
            self.stopping.append(completion); guard self.stopping.count == 1 else { return }
            self.stopped = true; self.generation &+= 1; self.heartbeatTimer?.cancel(); self.remoteConnected = false; self.startupComplete = false
            self.gate.set(self.generation, active: false)
            let group = DispatchGroup(); var first: Error?
            group.enter(); if let scheduler = self.scheduler { scheduler.stop { result in self.queue.async { if case .failure(let error) = result { first = error }; group.leave() } } } else { group.leave() }
            group.enter(); if let remote = self.remote { remote.close { group.leave() } } else { group.leave() }
            group.enter(); if self.heartbeatRunning { self.heartbeatWaiters.append { group.leave() } } else { group.leave() }
            group.notify(queue: self.queue) {
                self.withdraw(expected) { result in self.queue.async {
                    if case .failure(let error) = result, first == nil { first = error }
                    self.healthError = first; self.heartbeatHealthy = false
                    let callbacks = self.stopping; self.stopping.removeAll(); for callback in callbacks { callback(first) }; self.publish()
                } }
            }
        }
    }
    func check(_ expected: GuguIOSHostBinding) throws {
        guard try ownerAccess.ownerBinding() == expected else { throw Self.failure("stale_context", "Native owner or installation changed") }
        let ticket = try credentials(expected)
        guard ticket.binding == expected, ticket.expiresAt > Date() else { throw Self.failure("auth_unavailable", "Native verified credentials are unavailable") }
    }
    var workspacePath: String { root.appendingPathComponent("tasks", isDirectory: true).path }
    func project(_ binding: GuguIOSHostBinding) throws -> [String: Any] { ["id": try GuguIOSStableID.strings("phone-project", binding.ownerId, binding.deviceId), "name": "手机任务", "path": workspacePath] }
    func snapshot(_ expected: GuguIOSHostBinding) throws -> [String: Any] {
        try check(expected)
        guard binding == expected else { throw Self.failure("host_not_ready", "Native host is not configured") }
        let failure = healthError ?? heartbeatError ?? commandError ?? scheduler?.healthFailure() ?? missingDelivery
        let healthy = heartbeatAt.map { Date().timeIntervalSince($0) <= 60 } == true
        let ready = !stopped && startupComplete && remoteConnected && heartbeatHealthy && healthy && failure == nil
        let agents = try store?.snapshot()["agents"] as? [String: [String: Any]] ?? [:]
        let sessions = agents.values.map { agent -> [String: Any] in ["agentUserId": agent["agentUserId"] ?? NSNull(), "sessionId": agent["sessionId"] ?? NSNull(),
            "displayName": agent["displayName"] ?? "手机任务 Agent", "chatId": agent["chatId"] ?? NSNull(), "modelId": agent["modelId"] ?? NSNull(),
            "status": agent["status"] ?? "idle", "lastJobStatus": agent["lastJobStatus"] ?? NSNull()] }
        return ["ownerId": expected.ownerId, "deviceId": expected.deviceId, "status": failure != nil ? "failed" : stopped ? "stopped" : ready ? "ready" : "starting", "ready": ready,
            "taskTimeline": ready, "project": try project(expected), "sessions": sessions, "lastHeartbeatAt": heartbeatAt.map { Int64($0.timeIntervalSince1970 * 1000) } as Any? ?? NSNull(),
            "error": failure.map { Self.safe($0).message } as Any? ?? NSNull(), "errorCode": failure.map { Self.safe($0).code } as Any? ?? NSNull()]
    }
    func publish() {
        guard let binding else { return }
        if let state = try? snapshot(binding) { emit(state) }
    }
    func sync<T>(_ work: () throws -> T) rethrows -> T { if DispatchQueue.getSpecific(key: queueKey) == true { return try work() }; return try queue.sync(execute: work) }
    static func safe(_ error: Error) -> GuguHostFailure { error as? GuguHostFailure ?? failure("host_failed", "Native host operation failed") }
    static func failure(_ code: String, _ text: String) -> GuguHostFailure { .init(code: code, message: text) }
    static func replyError(_ error: Error, admission: String = "uncertain") -> [String: Any] { let value = safe(error); return ["error": ["code": value.code, "message": value.message, "admission": admission]] }
    static func errorState(_ binding: GuguIOSHostBinding, _ error: Error) -> [String: Any] { ["ownerId": binding.ownerId, "deviceId": binding.deviceId, "status": "failed", "ready": false, "taskTimeline": false, "sessions": [], "error": safe(error).message, "errorCode": safe(error).code] }
}
