import Foundation

private func require(_ condition: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !condition() { throw GuguHostFailure(code: "create_command_test_failed", message: text) }
}
private func awaitExecute(_ executor: GuguIOSCreateCommand, id: String) throws -> Result<Void, Error> {
    let wait = DispatchSemaphore(value: 0); var outcome: Result<Void, Error>?
    executor.execute(id: id) { outcome = $0; wait.signal() }
    try require(wait.wait(timeout: .now() + 10) == .success, "Command did not settle native callback"); return outcome!
}
private final class Fixture {
    let binding: GuguIOSHostBinding, store: GuguIOSBackendStore
    let commandId = UUID().uuidString.lowercased(), instanceId = UUID().uuidString.lowercased(), agentId = UUID().uuidString.lowercased(), chatId = UUID().uuidString.lowercased()
    var status = "pending", token: String?, claimedBy: String?, loseSettle = true, allowLease = true, foreignAgent = false, starts: [String] = [], casCount = 0
    init(_ root: URL) throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        store = try .init(root: root, binding: binding)
    }
    var row: [String: Any] { ["id": commandId, "device_id": binding.deviceId, "type": "agent.create", "status": status, "claim_token": token as Any? ?? NSNull(), "claimed_by": claimedBy as Any? ?? NSNull(), "payload": ["agent_user_id": agentId, "agent_type": "pi", "greeting_chat_id": chatId, "display_name": "fixture", "model": "platform:catalog-id"]] }
    lazy var broker = try! GuguIOSCloudBroker(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in .init(binding: expected, accessToken: "synthetic", expiresAt: Date().addingTimeInterval(3600)) }, send: { request, done in
        do {
            let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let name = request.url!.lastPathComponent; var value: Any = NSNull()
            if name == "gugu_device_commands" {
                if request.httpMethod == "PATCH", body["status"] as? String == "running" {
                    self.casCount += 1
                    if self.status == "pending" { self.status = "running"; self.token = body["claim_token"] as? String; self.claimedBy = body["claimed_by"] as? String; value = [["id": self.commandId, "claim_token": self.token!]] }
                    else { value = [] as [Any] }
                } else if request.httpMethod == "PATCH", body["status"] as? String == "done" {
                    self.status = "done"; value = [["id": self.commandId]]
                    if self.loseSettle { self.loseSettle = false; done(nil, nil, URLError(.networkConnectionLost)); return }
                } else if request.httpMethod == "PATCH", body["status"] as? String == "error" {
                    self.status = "error"; value = [["id": self.commandId]]
                } else { value = [self.row] }
            }
            if name == "recheck_device_command_execution" { value = self.allowLease }
            if name == "active_users" { value = [["id": self.agentId, "type": "agent", "owner_user_id": self.foreignAgent ? UUID().uuidString : self.binding.ownerId, "device_id": self.binding.deviceId, "display_name": "fixture"]] }
            if name == "model-access" { value = ["models": [["id": "catalog-id", "enabled": true, "protocols": ["openai-chat-completions"]]]] }
            done(try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
        } catch { done(nil, nil, error) }
    })
    func executor() -> GuguIOSCreateCommand {
        .init(broker: broker, store: store, instanceId: instanceId, projectPath: "/private/phone", check: {}, start: { agent, done in
            self.starts.append(agent["sessionId"] as! String); done(.success(()))
        })
    }
}
@main struct HostCreateCommandTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), fixture = try Fixture(root.appendingPathComponent("lost"))
        let first = try awaitExecute(fixture.executor(), id: fixture.commandId)
        guard case .failure(let error as GuguHostFailure) = first, error.code == "cloud_transport_uncertain" else { throw GuguHostFailure(code: "create_command_test_failed", message: "Lost settle ACK reported known success") }
        try require(fixture.status == "done" && fixture.starts.count == 1 && fixture.casCount == 1, "First execution did not claim and persist original session")
        let originalSession = fixture.starts[0], originalToken = fixture.token
        _ = try awaitExecute(fixture.executor(), id: fixture.commandId).get()
        try require(try fixture.store.record("requests", id: "command:\(fixture.commandId)")?["status"] as? String == "completed", "Reconciliation did not persist known completion")
        try require(fixture.starts == [originalSession, originalSession] && fixture.token == originalToken && fixture.casCount == 1, "Lost settlement retry minted a session or reclaimed command")
        var cases = ["claim_recheck_native_admission_and_lost_settlement_reconcile_same_session"]
        let denied = try Fixture(root.appendingPathComponent("denied")); denied.loseSettle = false; denied.allowLease = false
        guard case .failure(let error as GuguHostFailure) = try awaitExecute(denied.executor(), id: denied.commandId), error.code == "stale_context" else { throw GuguHostFailure(code: "create_command_test_failed", message: "Lost command lease executed") }
        try require(denied.starts.isEmpty && (try denied.store.snapshot()["agents"] as? [String: Any])?.isEmpty == true, "Lease denial created native session")
        cases.append("failed_claim_recheck_prevents_native_session_creation")
        let foreign = try Fixture(root.appendingPathComponent("foreign")); foreign.foreignAgent = true
        guard case .failure(let error as GuguHostFailure) = try awaitExecute(foreign.executor(), id: foreign.commandId), error.code == "not_granted" else { throw GuguHostFailure(code: "create_command_test_failed", message: "Foreign cloud Agent was accepted") }
        try require(foreign.starts.isEmpty && foreign.status == "error", "Foreign owner constructed native runtime or failed command stayed running")
        cases.append("foreign_cloud_owner_rejected_before_native_runtime_factory")
        let busy = try Fixture(root.appendingPathComponent("busy")); busy.status = "running"; busy.token = UUID().uuidString; busy.claimedBy = UUID().uuidString
        guard case .failure(let error as GuguHostFailure) = try awaitExecute(busy.executor(), id: busy.commandId), error.code == "admission_uncertain" else { throw GuguHostFailure(code: "create_command_test_failed", message: "Foreign running claim was stolen") }
        try require(busy.starts.isEmpty && busy.casCount == 0, "Foreign running command was reclaimed")
        cases.append("another_runtime_claim_is_preserved")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["kind": "native_agent_create_CAS_APFS_with_synthetic_cloud_and_runtime_factory", "result": "pass", "cases": cases, "realCloudHTTPCalls": 0, "realModelCalls": 0, "realPiRuntimeConstructions": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
