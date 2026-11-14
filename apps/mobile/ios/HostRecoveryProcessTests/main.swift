import Foundation
import CryptoKit

private func require(_ condition: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !condition() { throw GuguHostFailure(code: "recovery_process_failed", message: text) }
}
private func awaitValue<T>(_ start: (@escaping (T) -> Void) -> Void) throws -> T {
    let signal = DispatchSemaphore(value: 0); var value: T?
    start { value = $0; signal.signal() }
    try require(signal.wait(timeout: .now() + 15) == .success, "Native process callback timed out"); return value!
}
private final class RecoveryProcessModel: GuguModelCompleting {
    var calls = 0
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        completion(["ok": true, "data": ["choices": [["finish_reason": "tool_calls", "message": ["role": "assistant", "content": NSNull(),
            "tool_calls": [["id": "original-process-write", "type": "function", "function": ["name": "calendar_create", "arguments": "{\"title\":\"Synthetic unknown write\",\"start\":\"2026-11-15T10:00:00+08:00\"}"]]]]]]]])
    }
    func cancel(id: String) {}
}
private final class RecoveryProcessCalendar: GuguNativeToolExecutor {
    let effect: URL, began = DispatchSemaphore(value: 0)
    var writes = 0
    init(_ effect: URL) { self.effect = effect }
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        do {
            try control.checkActive(); try control.beginMutation(); writes += 1
            // A durable synthetic external effect, intentionally before its receipt.
            // The parent kills this exact child PID; no graceful stop runs here.
            try Data("one synthetic effect\n".utf8).write(to: effect, options: .atomic)
            let file = try FileHandle(forWritingTo: effect); try file.synchronize(); try file.close()
            began.signal()
        } catch { completion((error as? GuguHostFailure ?? .init(code: "fixture", message: "Synthetic effect failed")).envelope) }
    }
}
@main struct HostRecoveryProcessTests {
    static func main() throws {
        let phase = CommandLine.arguments[1], root = URL(fileURLWithPath: CommandLine.arguments[2]), asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3]))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let manifestURL = root.appendingPathComponent("identity.json")
        let identity: [String: String]
        if phase == "prepare" {
            identity = Dictionary(uniqueKeysWithValues: ["owner", "installation", "agent", "session", "epoch", "job"].map { ($0, UUID().uuidString.lowercased()) })
            try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]).write(to: manifestURL, options: .atomic)
        } else { identity = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as! [String: String] }
        let owner = identity["owner"]!, install = identity["installation"]!, agentId = identity["agent"]!, jobId = identity["job"]!
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        let store = try GuguIOSBackendStore(root: root.appendingPathComponent("backend"), binding: binding)
        let lifecycle = GuguIOSHostLifecycle(root: root.appendingPathComponent("journal"), verifiedIdentity: { binding })
        let agent = try store.admit("agents", id: agentId, fingerprint: agentId) {
            ["ownerId": owner, "deviceId": binding.deviceId, "agentUserId": agentId, "sessionId": identity["session"]!, "contextEpoch": identity["epoch"]!,
             "modelId": "synthetic-catalog", "displayName": "Synthetic recovery process", "status": "idle"]
        }
        let credentials: GuguIOSCloudBroker.Credentials = { expected in
            .init(binding: expected, accessToken: "synthetic-never-persisted-human", expiresAt: Date().addingTimeInterval(3600))
        }
        let send: GuguIOSCloudBroker.Send = { request, done in
            let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            let value: [String: Any] = body["action"] as? String == "issue"
                ? ["session_id": UUID().uuidString.lowercased(), "protocol": "openai-chat-completions", "relay_url": "https://synthetic-model.invalid", "token": "synthetic-never-persisted-model", "model": "synthetic-wire", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]
                : ["ok": true]
            done(try! JSONSerialization.data(withJSONObject: value), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
        }
        let configuration = GuguIOSBackendConfiguration(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public")
        let broker = try GuguIOSCloudBroker(configuration: configuration, credentials: credentials, send: send)
        let model = RecoveryProcessModel(), calendar = RecoveryProcessCalendar(root.appendingPathComponent("external-effect.txt")), changed = DispatchSemaphore(value: 0)
        let runtime = GuguPackagedRuntime(asset: asset, sha256: SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined(), piVersion: "1.4.0")
        let scheduler = try GuguIOSTaskScheduler.open(store: store, lifecycle: lifecycle, runtime: runtime, broker: broker, check: {}, executor: { calendar }, changed: { changed.signal() }, modelTransport: { _ in model })
        if phase == "prepare" {
            let admission: Result<Void, Error> = try awaitValue { scheduler.admit(agent: agent, text: "Synthetic process crash regression", id: jobId, completion: $0) }; try admission.get()
            let deadline = Date().addingTimeInterval(15)
            while try store.record("inputs", id: jobId)?["status"] as? String != "needs_user", Date() < deadline { _ = changed.wait(timeout: .now() + 0.01) }
            let journal = try lifecycle.journal(binding: binding)
            guard let permission = try journal.calls(jobId: jobId).first(where: { $0["status"] as? String == "needs_confirmation" })?["requestId"] as? String else {
                throw GuguHostFailure(code: "recovery_process_failed", message: "Original native write never requested one-use approval")
            }
            let approval: Result<[String: Any], Error> = try awaitValue { scheduler.respond(agent: agent, requestId: permission, option: "approve", completion: $0) }; _ = try approval.get()
            try require(calendar.began.wait(timeout: .now() + 15) == .success, "Synthetic external write did not begin")
            try require(model.calls == 1 && calendar.writes == 1, "Unexpected pre-crash dispatch count")
            let ready: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "phase": "effect-committed-without-receipt", "jobId": jobId, "modelCalls": 1, "writes": 1]
            try JSONSerialization.data(withJSONObject: ready).write(to: root.appendingPathComponent("ready.json"), options: .atomic)
            DispatchSemaphore(value: 0).wait()
        } else {
            let journal = try lifecycle.journal(binding: binding), calls = try journal.calls(jobId: jobId)
            try require(try store.record("inputs", id: jobId)?["status"] as? String == "interrupted", "Fresh process resumed old input custody")
            try require(calls.count == 1 && calls[0]["status"] as? String == "execution_unknown" && calls[0]["receipt"] == nil, "Unknown write lost its explicit no-receipt state")
            let establishment: Result<Void, Error> = try awaitValue { scheduler.establish(agent, completion: $0) }; try establishment.get()
            let timeline: [String: Any] = try awaitValue { scheduler.timeline(agent: agent, method: "snapshot", input: [:], completion: $0) }
            try require(timeline["ok"] as? Bool == true, "Interrupted task history was not observable")
            let transcript = try journal.continuationTranscript(jobId: jobId)
            try require(String(decoding: JSONSerialization.data(withJSONObject: transcript), as: UTF8.self).contains("execution_unknown"), "Explicit continuation hid the uncertain write")
            try require(model.calls == 0 && calendar.writes == 0 && Data(contentsOf: calendar.effect) == Data("one synthetic effect\n".utf8), "Reopen automatically replayed model or external write")
            // Reconcile the known original model lease through the production
            // recovery entry, without issuing a replacement or running a task.
            let access = GuguIOSOwnerAccess(root: root.appendingPathComponent("owner"), verifiedIdentity: { binding }, requireOwnerUI: {}, calendarHasFullAccess: { false }, revokeCalendarAccess: { _ in })
            let backend = try GuguIOSNativeBackend(root: root, runtime: runtime, lifecycle: lifecycle, ownerAccess: access, configuration: configuration,
                credentials: credentials, executor: { _ in calendar }, remoteInvoke: { _, _, _, _, _ in }, event: { _ in }, brokerSend: send)
            backend.store = store
            let recovered: Result<Void, Error> = try awaitValue { backend.recoverLeases(binding, completion: $0) }; try recovered.get()
            let leases = try store.snapshot()["leases"] as? [String: [String: Any]] ?? [:]
            try require(leases.count == 1 && leases.values.allSatisfy { $0["status"] as? String == "settled" }, "Known pre-crash model lease was not reconciled")
            let stopped: Result<Void, Error> = try awaitValue { scheduler.stop(completion: $0) }; try stopped.get()
            let result: [String: Any] = ["result": "pass", "phase": "fresh-process-reopened", "oldInput": "interrupted", "oldWrite": "execution_unknown", "newModelCalls": model.calls, "newWrites": calendar.writes, "externalEffects": 1, "settledOriginalLeases": leases.count, "realModelCalls": 0, "realCloudHTTPCalls": 0, "iosAppRuns": 0]
            print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self))
        }
    }
}
