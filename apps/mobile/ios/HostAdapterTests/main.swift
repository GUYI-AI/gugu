import Foundation

final class AdapterFixtureBackend: GuguIOSHostBackend {
    var ready = true, permitReplay = true, failStop = false, hold = false
    var invocations: [GuguIOSHostInvocation] = []
    var reconciliations = 0, stops = 0
    var pending: (([String: Any]) -> Void)?
    var reconcileReply: [String: Any] = ["error": ["code": "execution_unknown", "message": "Fixture has no known receipt", "admission": "uncertain"]]
    let invoked = DispatchSemaphore(value: 0)
    func configure(_ configuration: GuguIOSHostConfiguration, completion: @escaping ([String: Any]) -> Void) {
        completion(try! state(binding: configuration.binding))
    }
    func state(binding: GuguIOSHostBinding) throws -> [String: Any] {
        ["ownerId": binding.ownerId, "deviceId": binding.deviceId, "status": ready ? "ready" : "starting", "ready": ready, "sessions": []]
    }
    func invoke(_ call: GuguIOSHostInvocation, completion: @escaping ([String: Any]) -> Void) {
        invocations.append(call)
        if hold { pending = completion; invoked.signal() }
        else { completion(["result": ["requestId": call.requestId, "fixture": true]]) }
    }
    func authorizeReplay(_ call: GuguIOSHostInvocation) throws {
        if !permitReplay { throw GuguHostFailure(code: "not_granted", message: "Fixture replay revoked") }
    }
    func reconcile(_ call: GuguIOSHostInvocation, completion: @escaping ([String: Any]) -> Void) {
        reconciliations += 1; completion(reconcileReply)
    }
    func stop(binding: GuguIOSHostBinding, completion: @escaping (Error?) -> Void) {
        stops += 1
        completion(failStop ? GuguHostFailure(code: "stop_failed", message: "Fixture stop failed") : nil)
    }
}

@main struct HostAdapterTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let ownerId = UUID().uuidString.lowercased(), installationId = UUID().uuidString.lowercased()
        let binding = GuguIOSHostBinding(ownerId: ownerId, deviceId: "phone-\(installationId)-\(ownerId)", installationId: installationId)
        var current: GuguIOSHostBinding? = binding, ownerUI = true
        let backend = AdapterFixtureBackend()
        let adapter = GuguIOSHostAdapter(root: root, backend: backend, currentIdentity: { current }, requireOwnerUI: {
            if !ownerUI { throw GuguHostFailure(code: "not_granted", message: "Fixture remote surface") }
        })
        let configuration = GuguIOSHostConfiguration(binding: binding, grants: ["calendar": false], deviceMetadata: ["platform": "ios"])
        var cases: [String] = []
        for action in ["get", "refresh"] {
            let reply = try auth(adapter, action)
            try require(reply["available"] as? Bool == false && reply["session"] is NSNull, "Auth did not delegate")
        }
        try require(backend.invocations.isEmpty && backend.stops == 0, "Auth delegation touched backend")
        cases.append("auth_get_refresh_delegate_without_credentials")

        let secretConfig = GuguIOSHostConfiguration(binding: binding, grants: [:], deviceMetadata: ["refreshToken": "forbidden-fixture"])
        try error(try awaitReply { adapter.configure(secretConfig, completion: $0) }, "invalid_args")
        let foreignOwner = UUID().uuidString.lowercased()
        let foreign = GuguIOSHostBinding(ownerId: foreignOwner, deviceId: "phone-\(installationId)-\(foreignOwner)", installationId: installationId)
        try error(try awaitReply { adapter.configure(.init(binding: foreign, grants: [:], deviceMetadata: [:]), completion: $0) }, "stale_context")
        _ = try awaitReply { adapter.configure(configuration, completion: $0) }
        cases.append("configure_checks_native_identity_and_rejects_credential_metadata")

        backend.ready = false
        let startupId = UUID().uuidString
        try error(try invoke(adapter, binding, startupId, "sessionTimeline.sessionCreateOptions"), "host_not_ready")
        backend.ready = true
        let startup = try invoke(adapter, binding, startupId, "sessionTimeline.sessionCreateOptions")
        try require(startup["result"] != nil, "Startup retry cached transient failure")
        cases.append("startup_read_retry_does_not_cache_not_ready")

        backend.hold = true
        let id = UUID().uuidString, firstDone = DispatchSemaphore(value: 0)
        var first: [String: Any] = [:]
        adapter.hostCall(ownerId: binding.ownerId, id: id, channel: "sessionTimeline.sessionSend", args: ["fixture-input"], origin: .localOwnerUI) {
            first = $0; firstDone.signal()
        }
        try wait(backend.invoked)
        let before = backend.invocations.count
        try error(try invoke(adapter, binding, id, "sessionTimeline.sessionSend", args: ["fixture-input"]), "admission_uncertain")
        try require(backend.invocations.count == before, "Duplicate in-flight call executed again")
        backend.pending?(["result": ["accepted": true, "requestId": id]])
        try wait(firstDone)
        backend.hold = false
        try require(first["result"] != nil, "Original durable receipt missing")
        let replay = try invoke(adapter, binding, id, "sessionTimeline.sessionSend", args: ["fixture-input"])
        try require(replay["result"] != nil && backend.invocations.count == before, "Replay executed again")
        try error(try invoke(adapter, binding, id, "sessionTimeline.sessionSend", args: ["changed"]), "duplicate_conflict")
        backend.permitReplay = false
        try error(try invoke(adapter, binding, id, "sessionTimeline.sessionSend", args: ["fixture-input"]), "not_granted")
        backend.permitReplay = true
        cases.append("original_uuid_single_execution_conflict_and_guarded_replay")

        let decisions = backend.invocations.count
        try error(try invoke(adapter, binding, UUID().uuidString, "sessionTimeline.sessionRespond", origin: .remoteAgent), "not_granted")
        ownerUI = false
        try error(try invoke(adapter, binding, UUID().uuidString, "sessionTimeline.sessionRespond"), "not_granted")
        ownerUI = true
        try error(try invoke(adapter, binding, UUID().uuidString, "arbitrary.channel"), "unknown_method")
        try require(backend.invocations.count == decisions, "Rejected approval reached backend")
        cases.append("remote_approval_and_unknown_channel_rejected_before_backend")

        backend.hold = true
        let lateId = UUID().uuidString, lateDone = DispatchSemaphore(value: 0)
        var late: [String: Any] = [:]
        adapter.hostCall(ownerId: binding.ownerId, id: lateId, channel: "sessionTimeline.sessionSend", args: [], origin: .localOwnerUI) {
            late = $0; lateDone.signal()
        }
        try wait(backend.invoked)
        _ = try awaitReply { adapter.stopHost(ownerId: binding.ownerId, completion: $0) }
        current = foreign
        backend.pending?(["result": ["accepted": true, "requestId": lateId]])
        try wait(lateDone)
        try error(late, "stale_context")
        let oldStore = try GuguHostCallStore(root: root, binding: binding)
        let oldCall = GuguIOSHostInvocation(binding: binding, requestId: lateId, channel: "sessionTimeline.sessionSend", arguments: [], origin: .localOwnerUI)
        try require(try oldStore.admit(oldCall)["status"] as? String == "completed", "Late known receipt was lost")
        backend.hold = false; current = binding
        _ = try awaitReply { adapter.configure(configuration, completion: $0) }
        cases.append("retired_owner_late_receipt_saved_but_not_delivered")

        let uncertainId = UUID().uuidString
        let uncertain = GuguIOSHostInvocation(binding: binding, requestId: uncertainId, channel: "sessionTimeline.sessionSend", arguments: ["uncertain"], origin: .localOwnerUI)
        _ = try oldStore.admit(uncertain); try oldStore.begin(uncertain)
        _ = try awaitReply { adapter.stopHost(ownerId: binding.ownerId, completion: $0) }
        _ = try awaitReply { adapter.configure(configuration, completion: $0) }
        backend.reconcileReply = ["result": ["accepted": true, "requestId": uncertainId]]
        let invokedBeforeReconcile = backend.invocations.count
        _ = try invoke(adapter, binding, uncertainId, "sessionTimeline.sessionSend", args: ["uncertain"])
        try require(backend.reconciliations == 1 && backend.invocations.count == invokedBeforeReconcile, "Uncertain admission was blindly re-executed")
        cases.append("reopened_uncertain_call_uses_backend_reconciliation")

        backend.failStop = true
        for _ in 0..<2 {
            do { _ = try auth(adapter, "sign_out"); throw failure("Failed stop delegated logout") }
            catch let failure as GuguHostFailure { if failure.code != "stop_failed" { throw failure } }
        }
        backend.failStop = false
        try require(try auth(adapter, "sign_out")["available"] as? Bool == false, "Successful stop did not delegate logout")
        cases.append("sign_out_stop_failure_rejects_until_actual_stop")

        let rotationRoot = root.appendingPathComponent("call-store-rotation")
        let one = try GuguHostCallStore(root: rotationRoot, binding: binding)
        let a = GuguIOSHostInvocation(binding: binding, requestId: UUID().uuidString, channel: "sessionTimeline.sessionSend", arguments: ["a"], origin: .localOwnerUI)
        _ = try one.admit(a); try one.begin(a)
        let two = try GuguHostCallStore(root: rotationRoot, binding: binding)
        let b = GuguIOSHostInvocation(binding: binding, requestId: UUID().uuidString, channel: "sessionTimeline.sessionSend", arguments: ["b"], origin: .localOwnerUI)
        _ = try two.admit(b); try two.begin(b)
        try one.finish(a, reply: ["result": "a-known"]); try two.finish(b, reply: ["result": "b-known"])
        try require(try one.admit(b)["status"] as? String == "completed", "Old call store erased new operation")
        try require(try two.admit(a)["status"] as? String == "completed", "New call store erased late receipt")
        do { try one.finish(a, reply: ["result": "overwritten"]); throw failure("Known receipt was overwritten") }
        catch let failure as GuguHostFailure { if failure.code != "duplicate_conflict" { throw failure } }
        cases.append("call_store_rotation_preserves_both_terminal_receipts")

        print(String(data: try JSONSerialization.data(withJSONObject: ["kind": "macos_adapter_with_injected_backend_only", "result": "pass", "cases": cases,
            "realCloudCalls": 0, "realModelCalls": 0, "realEventKitCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    }
    static func invoke(_ adapter: GuguIOSHostAdapter, _ binding: GuguIOSHostBinding, _ id: String, _ channel: String,
                       args: [Any] = [], origin: GuguIOSHostCallOrigin = .localOwnerUI) throws -> [String: Any] {
        try awaitReply { adapter.hostCall(ownerId: binding.ownerId, id: id, channel: channel, args: args, origin: origin, completion: $0) }
    }
    static func awaitReply(_ work: (@escaping ([String: Any]) -> Void) -> Void) throws -> [String: Any] {
        let done = DispatchSemaphore(value: 0); var reply: [String: Any] = [:]
        work { reply = $0; done.signal() }; try wait(done); return reply
    }
    static func auth(_ adapter: GuguIOSHostAdapter, _ action: String) throws -> [String: Any] {
        let done = DispatchSemaphore(value: 0); var result: Result<[String: Any], Error>?
        adapter.authSession(action: action) { result = $0; done.signal() }; try wait(done); return try result!.get()
    }
    static func wait(_ done: DispatchSemaphore) throws { if done.wait(timeout: .now() + 10) != .success { throw failure("Callback timed out") } }
    static func require(_ value: Bool, _ message: String) throws { if !value { throw failure(message) } }
    static func error(_ reply: [String: Any], _ code: String) throws { try require((reply["error"] as? [String: Any])?["code"] as? String == code, "Expected \(code), got \(reply)") }
    static func failure(_ message: String) -> GuguHostFailure { GuguHostFailure(code: "adapter_regression", message: message) }
}
