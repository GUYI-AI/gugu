import Foundation
import CryptoKit

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "broker_path_test_failed", message: text) }
}
private func wait<T>(_ work: (@escaping (T) -> Void) -> Void) throws -> T {
    let semaphore = DispatchSemaphore(value: 0); var outcome: T?
    work { outcome = $0; semaphore.signal() }
    try require(semaphore.wait(timeout: .now() + 15) == .success, "Native broker path timed out"); return outcome!
}
private final class Calendar: GuguNativeToolExecutor {
    var writes = 0
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        do { try control.beginMutation(); writes += 1; let result: [String: Any] = ["event_id": "synthetic-calendar-event"]; try control.finishMutation(result); completion(["ok": true, "data": result]) }
        catch { completion((error as? GuguHostFailure ?? .init(code: "fixture", message: "Synthetic calendar failed")).envelope) }
    }
}
private final class Model: GuguModelCompleting {
    var calls = 0
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        guard body["model"] as? String == "synthetic-issued-wire-model" else { completion(["ok": false, "code": "fixture", "message": "Native short lease wire mapping differs"]); return }
        let messages = body["messages"] as! [[String: Any]], tool = messages.contains { $0["role"] as? String == "tool" }
        let message: [String: Any] = tool ? ["role": "assistant", "content": "Synthetic real Pi broker path completed"] : ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "synthetic-one-calendar-call", "type": "function", "function": ["name": "calendar_create", "arguments": "{\"title\":\"Fixture only\",\"start\":\"2026-11-08T12:00:00+08:00\"}"]]]]
        completion(["ok": true, "data": ["choices": [["finish_reason": tool ? "stop" : "tool_calls", "message": message]]]])
    }
    func cancel(id: String) {}
}
private final class Fixture {
    let binding: GuguIOSHostBinding
    let agent = UUID().uuidString.lowercased(), command = UUID().uuidString.lowercased(), chat = UUID().uuidString.lowercased()
    let model = Model(), calendar = Calendar(), lock = NSRecursiveLock()
    var operation: String?, provision: String?, commandStatus = "pending", claim: String?, instance: String?, modelActions: [String] = [], starts = 0
    var cloudModel = "catalog-deepseek-v4-pro", device: [String: Any]?
    init() { let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased(); binding = .init(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install) }
    var send: GuguIOSCloudBroker.Send { { request, done in
        self.lock.lock(); defer { self.lock.unlock() }
        do {
            let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let name = request.url!.lastPathComponent; var result: Any = NSNull()
            switch name {
            case "runtime_instance_heartbeat", "complete_agent_provision", "set_agent_runtime_state": break
            case "recover_orphaned_device_commands": result = 0
            case "fetch_fair_pending_device_commands": result = [Any]()
            case "gugu_devices":
                if request.httpMethod == "POST" { self.device = body; result = [body] }
                else if request.httpMethod == "PATCH" { result = [["device_id": self.binding.deviceId]] }
                else { result = self.device.map { [$0] } ?? [] }
            case "model-access":
                let action = body["action"] as! String; self.modelActions.append(action)
                if action == "catalog" { result = ["models": [["id": self.cloudModel, "display_name": "DeepSeek V4 Pro", "enabled": true, "protocols": ["openai-chat-completions"]]]] }
                else if action == "issue" {
                    try require(body["agent_user_id"] as? String == self.agent && body["model_id"] as? String == self.cloudModel && UUID(uuidString: body["provider_session_id"] as? String ?? "") != nil, "Issue did not use actual provisioned agent/session/catalog")
                    result = ["session_id": UUID().uuidString.lowercased(), "protocol": "openai-chat-completions", "relay_url": "https://synthetic-relay.invalid", "token": "synthetic-short-lease-only", "model": "synthetic-issued-wire-model", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]
                } else { result = ["ok": true] }
            case "start_agent_provision_operation":
                self.starts += 1; self.operation = body["p_operation_id"] as? String
                self.provision = ((body["p_blueprint"] as! [String: Any])["members"] as! [[String: Any]])[0]["provision_id"] as? String
            case "agent_provisions", "prepare_agent_provision", "settle_agent_provision_terminal":
                result = [["id": self.provision!, "operation_id": self.operation!, "member_key": "single", "agent_type": "pi", "device_id": self.binding.deviceId, "display_name": "synthetic", "agent_user_id": self.agent, "create_command_id": self.command, "phase": name == "agent_provisions" ? "preparing" : name == "prepare_agent_provision" ? "creating" : "completed"]]
            case "gugu_device_commands":
                if request.httpMethod == "PATCH", body["status"] as? String == "running" {
                    try require(self.commandStatus == "pending", "Create command claimed twice"); self.commandStatus = "running"; self.claim = body["claim_token"] as? String; self.instance = body["claimed_by"] as? String
                    result = [["id": self.command, "claim_token": self.claim!]]
                } else if request.httpMethod == "PATCH" {
                    self.commandStatus = body["status"] as! String; result = [["id": self.command]]
                } else {
                    result = [["id": self.command, "device_id": self.binding.deviceId, "type": "agent.create", "status": self.commandStatus, "claim_token": self.claim as Any? ?? NSNull(), "claimed_by": self.instance as Any? ?? NSNull(), "payload": ["agent_user_id": self.agent, "agent_type": "pi", "greeting_chat_id": self.chat, "display_name": "synthetic", "project_path": "", "model": "platform:\(self.cloudModel)"]]]
                }
            case "active_users": result = [["id": self.agent, "type": "agent", "owner_user_id": self.binding.ownerId, "device_id": self.binding.deviceId, "display_name": "synthetic"]]
            case "recheck_device_command_execution": result = true
            default: throw GuguHostFailure(code: "fixture", message: "Unexpected named cloud request: \(name)")
            }
            done(try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
        } catch { done(nil, nil, error) }
    } }
}
@main struct HostBrokerPathTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])), f = Fixture(), changed = DispatchSemaphore(value: 0)
        let owner = GuguIOSOwnerAccess(root: root.appendingPathComponent("owner"), verifiedIdentity: { f.binding }, requireOwnerUI: {}, calendarHasFullAccess: { true }, revokeCalendarAccess: { _ in })
        let lifecycle = GuguIOSHostLifecycle(root: root.appendingPathComponent("journal"), verifiedIdentity: { f.binding })
        let runtime = GuguPackagedRuntime(asset: asset, sha256: SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined(), piVersion: "1.4.0")
        let service = try GuguIOSHostService(root: root.appendingPathComponent("service"), runtime: runtime, lifecycle: lifecycle, ownerAccess: owner, configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in .init(binding: expected, accessToken: "synthetic-native-human", expiresAt: Date().addingTimeInterval(3600)) }, executor: { _ in f.calendar }, deviceMetadata: { ["label": "fixture", "hostname": "fixture", "osName": "iOS fixture", "tier": "mobile"] }, brokerSend: f.send, socketFactory: { _ in throw GuguHostFailure(code: "fixture", message: "Realtime deliberately unavailable in native probe") }, modelTransport: { _ in f.model })
        service.observeState { _ in changed.signal() }
        let configured: [String: Any] = try wait { service.configure(["expectedBinding": ["ownerId": f.binding.ownerId, "deviceId": f.binding.deviceId, "installationId": f.binding.installationId]], completion: $0) }
        try require(configured["ready"] as? Bool == false, "Native probe enabled product capability")
        let probe = try GuguIOSHostProbe(service: service, expectedBinding: f.binding)
        let selected: Result<String, Error> = try wait { probe.deepSeekV4Pro(completion: $0) }; try require(try selected.get() == f.cloudModel, "Exact catalog selection failed")
        let original = UUID().uuidString.lowercased()
        let created: [String: Any] = try wait { probe.create(requestId: original, prompt: "Synthetic broker path calendar approval", completion: $0) }
        guard let result = created["result"] as? [String: Any], let session = result["conversationId"] as? String else { throw GuguHostFailure(code: "broker_path_test_failed", message: "Native probe creation failed: \(created)") }
        let inputID = try GuguIOSStableID.strings(f.operation!, "initial-task")
        func awaitStatus(_ status: String) throws {
            let deadline = Date().addingTimeInterval(15)
            while Date() < deadline {
                let journal = try lifecycle.journal(binding: f.binding)
                if let job = try? journal.job(inputID), job["status"] as? String == status { return }
                _ = changed.wait(timeout: .now() + 0.1)
            }
            throw GuguHostFailure(code: "broker_path_test_failed", message: "Native probe did not reach \(status)")
        }
        try awaitStatus("needs_user")
        let snapshot: [String: Any] = try wait { probe.snapshot(requestId: UUID().uuidString.lowercased(), sessionId: session, completion: $0) }
        let item = try lifecycle.journal(binding: f.binding).calls(jobId: inputID).first!["requestId"] as! String
        try require(String(decoding: try JSONSerialization.data(withJSONObject: snapshot), as: UTF8.self).contains(item) && f.calendar.writes == 0, "Exact approval absent or synthetic write ran early")
        let approved: [String: Any] = try wait { probe.respond(requestId: UUID().uuidString.lowercased(), sessionId: session, itemId: item, optionId: "approve", completion: $0) }
        try require((approved["result"] as? [String: Any])?["accepted"] as? Bool == true, "Native probe approval failed")
        try awaitStatus("done")
        let final: [String: Any] = try wait { probe.snapshot(requestId: UUID().uuidString.lowercased(), sessionId: session, completion: $0) }
        let finalJSON = String(decoding: try JSONSerialization.data(withJSONObject: final), as: UTF8.self)
        try require(finalJSON.contains("Synthetic real Pi broker path completed") && finalJSON.contains("resolved") && f.calendar.writes == 1 && f.model.calls == 2, "Real Pi/timeline did not complete exact approved path")
        let repeated: [String: Any] = try wait { probe.create(requestId: original, prompt: "Synthetic broker path calendar approval", completion: $0) }
        try require((repeated["result"] as? [String: Any])?["conversationId"] as? String == session && f.starts == 1 && f.model.calls == 2, "Original probe retry regenerated saga or reran inference")
        let stopped: [String: Any] = try wait { service.prepareOwnerRetirement(expectedBinding: f.binding, completion: $0) }
        try require(stopped.isEmpty && f.modelActions.filter { $0 == "issue" }.count == 1 && f.modelActions.contains("checkpoint") && f.modelActions.contains("revoke"), "Native short-lease cleanup did not settle")
        let state = String(decoding: try Data(contentsOf: root.appendingPathComponent("service/backend/\(f.binding.ownerId)/backend.json")), as: UTF8.self)
        try require(!state.contains("synthetic-native-human") && !state.contains("synthetic-short-lease-only"), "Credential entered native durable records")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "single_frozen_native_probe_actual_Pi_JSC_APFS_synthetic_cloud_model_calendar", "cases": ["exact_DeepSeek_V4_Pro_catalog_to_provision_CAS_short_lease_Pi_calendar_approval_timeline", "original_creation_retry_does_not_reprovision_or_repeat_inference", "checkpoint_revoke_and_native_credential_nonpersistence"], "realCloudHTTPCalls": 0, "realModelCalls": 0, "realEventKitCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
