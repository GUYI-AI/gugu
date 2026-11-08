import Foundation

private func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw GuguHostFailure(code: "provision_test_failed", message: message) }
}
private final class Fixture {
    let binding: GuguIOSHostBinding
    let store: GuguIOSBackendStore
    var requests: [[String: Any]] = [], loseFirstStart = true, initialFails = false, wrongDevice = false
    let agentId = UUID().uuidString.lowercased(), sessionId = UUID().uuidString.lowercased(), chatId = UUID().uuidString.lowercased()
    var commandId = UUID().uuidString.lowercased(), priorError = false, errorSettled = false, retryGranted = false, executedCommandIDs: [String] = []
    var operation: String?, provision: String?, acceptedIDs: [String] = []
    init(_ root: URL) throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        store = try GuguIOSBackendStore(root: root, binding: binding)
    }
    lazy var broker: GuguIOSCloudBroker = try! GuguIOSCloudBroker(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
        try require(expected == self.binding, "Credential binding changed")
        return .init(binding: expected, accessToken: "synthetic", expiresAt: Date().addingTimeInterval(3600))
    }, send: { request, done in
        do {
            let name = request.url!.lastPathComponent
            let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            self.requests.append(["name": name, "body": body])
            var value: Any = NSNull()
            if name == "model-access" { value = ["models": [["id": "selected-model", "display_name": "fixture", "enabled": true, "protocols": ["openai-chat-completions"]]]] }
            if name == "start_agent_provision_operation" {
                let operation = body["p_operation_id"] as! String
                let provision = ((body["p_blueprint"] as! [String: Any])["members"] as! [[String: Any]])[0]["provision_id"] as! String
                if let original = self.operation { try require(original == operation && self.provision == provision, "Lost response regenerated provision identity") }
                self.operation = operation; self.provision = provision
                if self.loseFirstStart { self.loseFirstStart = false; done(nil, nil, URLError(.networkConnectionLost)); return }
            }
            if ["agent_provisions", "prepare_agent_provision", "settle_agent_provision_terminal"].contains(name) {
                if name == "prepare_agent_provision", self.priorError, self.retryGranted { self.commandId = UUID().uuidString.lowercased() }
                if name == "settle_agent_provision_terminal", self.priorError, !self.retryGranted { self.errorSettled = true }
                let phase = self.priorError && !self.retryGranted ? (self.errorSettled ? "failed" : "awaiting_terminal") : name == "settle_agent_provision_terminal" ? "completed" : "preparing"
                value = [["id": self.provision!, "operation_id": self.operation!, "device_id": self.wrongDevice ? "wrong-device" : self.binding.deviceId,
                    "member_key": "single", "agent_type": "pi", "phase": phase,
                    "agent_user_id": self.agentId, "create_command_id": self.commandId]]
            }
            if name == "claim_provision_slots", self.priorError {
                try require(self.errorSettled && body["p_retry_provision_ids"] as? [String] == [self.provision!], "Failed member retry bypassed original provision selection")
                self.retryGranted = true
            }
            if name == "gugu_device_commands" { value = [["id": self.commandId, "status": self.priorError && !self.retryGranted ? "error" : "done"]] }
            done(try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
        } catch { done(nil, nil, error) }
    })
    func provisioner() throws -> GuguIOSProvisioner {
        try GuguIOSProvisioner(store: store, broker: broker, projectPath: "/private/phone", check: {}, executeCreate: { command, done in
            do {
                try require(command == self.commandId, "Executor got another command")
                self.executedCommandIDs.append(command)
                _ = try self.store.admit("agents", id: self.agentId, fingerprint: command) { ["agentUserId": self.agentId, "sessionId": self.sessionId,
                    "displayName": "fixture", "chatId": self.chatId, "modelId": "selected-model", "contextEpoch": UUID().uuidString, "status": "idle"] }
                done(.success(()))
            } catch { done(.failure(error)) }
        }, admit: { agent, prompt, id, done in
            do {
                if self.initialFails { throw GuguHostFailure(code: "fixture_disk_error", message: "Injected admission failure") }
                _ = try self.store.admit("inputs", id: id, fingerprint: prompt) { ["prompt": prompt, "agentId": agent["agentUserId"]!, "status": "queued"] }
                self.acceptedIDs.append(id); done(.success(()))
            } catch { done(.failure(error)) }
        })
    }
}
private func awaitCreate(_ provisioner: GuguIOSProvisioner, _ id: String, _ input: [String: Any]) throws -> Result<[String: Any], Error> {
    let done = DispatchSemaphore(value: 0); var outcome: Result<[String: Any], Error>?
    provisioner.create(requestId: id, input: input) { outcome = $0; done.signal() }
    guard done.wait(timeout: .now() + 10) == .success, let outcome else { throw GuguHostFailure(code: "provision_test_failed", message: "Native callback did not settle") }
    return outcome
}
@main struct HostProvisionTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let f = try Fixture(root.appendingPathComponent("retry")), requestId = UUID().uuidString, client = UUID().uuidString
        let input: [String: Any] = ["prompt": "fixture initial task", "clientRequestId": client, "model": "platform:selected-model"]
        let first = try awaitCreate(f.provisioner(), requestId, input)
        guard case .failure(let error as GuguHostFailure) = first, error.code == "cloud_transport_uncertain" else { throw GuguHostFailure(code: "provision_test_failed", message: "Lost ACK was accepted") }
        try require(f.acceptedIDs.isEmpty && f.operation != nil, "Uncertain provision ran initial task")
        var cases = ["lost_start_ACK_retains_intent_without_accepting"]
        let created = try awaitCreate(f.provisioner(), UUID().uuidString, input).get()
        try require(created["conversationId"] as? String == f.sessionId && created["agentUserId"] as? String == f.agentId, "Saga returned another session or identity")
        let starts = f.requests.filter { $0["name"] as? String == "start_agent_provision_operation" }
        try require(starts.count == 2, "Expected one original start and one same-ID reconciliation")
        try require(f.acceptedIDs == [try GuguIOSStableID.strings(f.operation!, "initial-task")], "Initial task ID differs from Android namespace")
        let before = f.requests.count
        let replay = try awaitCreate(f.provisioner(), UUID().uuidString, input).get()
        try require(replay["conversationId"] as? String == f.sessionId && f.requests.count == before && f.acceptedIDs.count == 1, "Completed replay ran provisioning or a second task")
        cases.append("same_client_retry_preserves_operation_provision_session_and_initial_task_IDs")
        var changed = input; changed["prompt"] = "changed text"
        let denied = try awaitCreate(f.provisioner(), requestId, changed)
        guard case .failure(let error as GuguHostFailure) = denied, error.code == "duplicate_conflict" else { throw GuguHostFailure(code: "provision_test_failed", message: "Changed retry was admitted") }
        try require(f.requests.count == before, "Changed retry touched cloud")
        cases.append("changed_input_same_client_ID_rejected_before_cloud")
        let failed = try Fixture(root.appendingPathComponent("admission")); failed.loseFirstStart = false; failed.initialFails = true
        let p = try failed.provisioner(), id = UUID().uuidString
        guard case .failure = try awaitCreate(p, id, input) else { throw GuguHostFailure(code: "provision_test_failed", message: "Failed durable initial admission was acknowledged") }
        try require(try failed.store.record("requests", id: "client:\(client)")?["result"] == nil, "Early session result persisted")
        failed.initialFails = false
        _ = try awaitCreate(p, id, input).get()
        try require(failed.acceptedIDs.count == 1, "Admission retry ran duplicate initial task")
        cases.append("initial_admission_failure_has_no_accepted_receipt_then_same_ID_retry")
        let wrong = try Fixture(root.appendingPathComponent("scope")); wrong.loseFirstStart = false; wrong.wrongDevice = true
        guard case .failure(let error as GuguHostFailure) = try awaitCreate(wrong.provisioner(), id, input), error.code == "stale_context" else { throw GuguHostFailure(code: "provision_test_failed", message: "Wrong device provision was accepted") }
        try require(wrong.acceptedIDs.isEmpty && (try wrong.store.snapshot()["agents"] as? [String: Any])?.isEmpty == true, "Wrong device created native identity")
        cases.append("foreign_device_provision_rejected_before_native_session_admission")
        let retry = try Fixture(root.appendingPathComponent("failed-command")); retry.loseFirstStart = false; retry.priorError = true
        let originalCommand = retry.commandId, originalRequest = UUID().uuidString.lowercased()
        let settledError = try awaitCreate(retry.provisioner(), originalRequest, input)
        guard case .failure(let error as GuguHostFailure) = settledError, error.code == "provision_failed" else { throw GuguHostFailure(code: "provision_test_failed", message: "Old error command did not settle failed") }
        try require(retry.errorSettled && retry.executedCommandIDs.isEmpty && retry.commandId == originalCommand, "Error command was reset or executed instead of preserving terminal evidence")
        let operation = retry.operation, provision = retry.provision
        let restored = try awaitCreate(retry.provisioner(), originalRequest, input).get()
        try require(retry.operation == operation && retry.provision == provision && restored["agentUserId"] as? String == retry.agentId && retry.commandId != originalCommand, "Failed-member recovery changed intent/Agent or bypassed server replacement command")
        try require(retry.executedCommandIDs == [retry.commandId] && retry.acceptedIDs == [try GuguIOSStableID.strings(operation!, "initial-task")], "Recovery executed the old command or admitted another initial input identity")
        cases.append("old_error_settles_then_explicit_same_intent_retry_reuses_Agent_and_server_command_protocol")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["kind": "native_provision_saga_APFS_with_synthetic_cloud_and_command_executor", "cases": cases,
            "result": "pass", "realCloudHTTPCalls": 0, "realModelCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
