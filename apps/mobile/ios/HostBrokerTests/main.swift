import Foundation

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "broker_test_failed", message: text) }
}
private func failure(_ code: String, _ action: () throws -> Void) throws {
    do { try action(); throw GuguHostFailure(code: "broker_test_failed", message: "Expected \(code)") }
    catch let error as GuguHostFailure { try require(error.code == code, "Unexpected failure \(error.code)") }
}
private func binding() -> GuguIOSHostBinding {
    let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
    return GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
}
private final class HTTPFixture {
    var pending: [(URLRequest, (Data?, URLResponse?, Error?) -> Void)] = []
    func send(_ request: URLRequest, _ done: @escaping (Data?, URLResponse?, Error?) -> Void) { pending.append((request, done)) }
    func reply(_ value: Any, status: Int = 200, before: (() -> Void)? = nil) throws {
        let (request, done) = pending.removeFirst(); before?()
        done(try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
             HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:]), nil)
    }
}
@main struct HostBrokerTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), original = binding()
        var current = original, token = "synthetic-native-only", available = true
        let http = HTTPFixture()
        let broker = try GuguIOSCloudBroker(configuration: GuguIOSBackendConfiguration(version: 1, supabaseUrl: "https://fixture.invalid/gateway", anonKey: "public-fixture"), credentials: { expected in
            guard available, current == expected else { throw GuguHostFailure(code: "stale_context", message: "Synthetic publication changed") }
            return GuguIOSOwnerCredentials(binding: current, accessToken: token, expiresAt: Date().addingTimeInterval(3600))
        }, send: http.send)
        var cases: [String] = [], result: Result<Any, Error>?
        let operation = UUID().uuidString, provision = UUID().uuidString
        broker.perform(.startProvision(operationId: operation, provisionId: provision, displayName: "fixture", modelId: "catalog-id"), binding: original) { result = $0 }
        let request = http.pending[0].0
        let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
        try require(request.url!.path == "/gateway/rest/v1/rpc/start_agent_provision_operation" && request.httpMethod == "POST", "Wrong existing provision endpoint")
        try require(request.value(forHTTPHeaderField: "Content-Profile") == "identity" && request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-native-only", "Native credentials/schema absent")
        try require(body["p_operation_id"] as? String == operation && body["p_device_id"] as? String == original.deviceId, "Original provision IDs changed")
        try require(!String(decoding: request.httpBody!, as: UTF8.self).contains(token), "Token entered cloud body")
        try http.reply(["ok": true]); _ = try result!.get(); cases.append("existing_provision_wire_and_native_only_credentials")

        result = nil
        let command = UUID().uuidString, claim = UUID().uuidString, instance = UUID().uuidString
        broker.perform(.claimCommand(id: command, claimToken: claim, instanceId: instance, at: "2026-11-08T00:00:00Z"), binding: original) { result = $0 }
        let claimRequest = http.pending[0].0, query = URLComponents(url: claimRequest.url!, resolvingAgainstBaseURL: false)!.queryItems!
        try require(claimRequest.httpMethod == "PATCH" && query.contains(.init(name: "status", value: "eq.pending")), "Command claim lost CAS")
        try require(query.contains(.init(name: "device_id", value: "eq.\(original.deviceId)")), "Command claim lost device scope")
        try http.reply([["id": command, "claim_token": claim]]); _ = try result!.get(); cases.append("command_claim_keeps_existing_CAS_and_claim_token")

        result = nil
        broker.perform(.heartbeat(instanceId: instance), binding: original) { result = $0 }
        try http.reply(["ok": true], before: { current = binding() })
        try failure("stale_context") { _ = try result!.get() }
        try require(http.pending.isEmpty, "Stale reply was retried")
        current = original; cases.append("late_old_owner_reply_rejected_without_retry")
        broker.perform(.heartbeat(instanceId: instance), binding: original) { result = $0 }
        try http.reply(["ok": true], before: { token = "synthetic-rotated" })
        try failure("stale_context") { _ = try result!.get() }; cases.append("same_owner_rotation_rejects_late_token_reply")
        available = false
        broker.perform(.heartbeat(instanceId: instance), binding: original) { result = $0 }
        try failure("stale_context") { _ = try result!.get() }
        try require(http.pending.isEmpty, "Unavailable publication sent HTTP or refreshed")
        available = true; cases.append("missing_publication_performs_zero_HTTP_and_zero_refresh")

        let store = try GuguIOSBackendStore(root: root, binding: original), other = try GuguIOSBackendStore(root: root, binding: original)
        let saved = try store.admit("requests", id: "client:\(command)", fingerprint: "same") {
            ["operationId": operation, "provisionId": provision, "status": "pending"]
        }
        let replay = try other.admit("requests", id: "client:\(command)", fingerprint: "same") { throw GuguHostFailure(code: "broker_test_failed", message: "Replay generated new IDs") }
        try require(saved["operationId"] as? String == replay["operationId"] as? String && saved["provisionId"] as? String == replay["provisionId"] as? String, "Lost reply changed saga IDs")
        try failure("duplicate_conflict") { _ = try other.admit("requests", id: "client:\(command)", fingerprint: "different") { [:] } }
        _ = try store.admit("inputs", id: provision, fingerprint: "input") { ["status": "running"] }
        try other.update("requests", id: "client:\(command)") { $0["status"] = "uncertain" }
        try require(try store.record("inputs", id: provision)?["status"] as? String == "running", "Second handle lost newer input")
        let reopened = try GuguIOSBackendStore(root: root, binding: original)
        try require(try reopened.record("requests", id: "client:\(command)")?["status"] as? String == "uncertain", "Reopen guessed uncertain write outcome")
        cases.append("cross_handle_durable_saga_IDs_and_uncertain_no_replay")
        try failure("invalid_args") { _ = try store.admit("leases", id: UUID().uuidString, fingerprint: "lease") { ["token": "must-not-persist"] } }
        try require(!(try JSONSerialization.data(withJSONObject: store.snapshot())).contains(Data("must-not-persist".utf8)), "Credential persisted")
        cases.append("credential_fields_rejected_before_disk_commit")

        var catalog: Result<[[String: Any]], Error>?
        broker.catalog(binding: original) { catalog = $0 }
        try http.reply(["models": [["id": "ok", "enabled": true, "protocols": ["openai-chat-completions"]], ["id": "hidden", "enabled": true, "hidden": true, "protocols": ["openai-chat-completions"]], ["id": "other", "enabled": true, "protocols": ["anthropic-messages"]]]])
        try require(try catalog!.get().count == 1, "Catalog advertised unsupported model protocol")
        cases.append("catalog_filters_existing_protocol_and_hidden_policy")
        var grant: Result<GuguIOSModelGrant, Error>?
        let agent = UUID().uuidString, session = UUID().uuidString, lease = UUID().uuidString
        broker.issueModel(binding: original, agentId: agent, sessionId: session, modelId: "catalog-id", recordLease: { id in
            _ = try store.admit("leases", id: id, fingerprint: session) { ["sessionId": session, "agentId": agent, "status": "issued"] }
        }) { grant = $0 }
        try http.reply(["session_id": lease, "protocol": "openai-chat-completions", "relay_url": "https://model.invalid/gateway", "token": "synthetic-short-lease", "model": "wire-model", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))])
        let native = try grant!.get()
        try require(native.lease.completionsURL.absoluteString == "https://model.invalid/gateway/v1/chat/completions", "Relay path prefix was lost")
        try require(native.lease.agentUserId == agent && native.lease.sessionId == session && native.lease.modelId == "wire-model", "Native lease scope/model changed")
        try require(!native.debugDescription.contains("synthetic-short-lease"), "Debug output exposed lease")
        cases.append("native_model_grant_keeps_scope_and_existing_relay_path")
        var settled: Result<Void, Error>?
        broker.settleModel(binding: original, leaseId: lease) { settled = $0 }
        try http.reply(["ignored": true], status: 503)
        try require(http.pending.count == 1, "Checkpoint failure skipped revoke")
        let revokeBody = try JSONSerialization.jsonObject(with: http.pending[0].0.httpBody!) as! [String: Any]
        try require(revokeBody["action"] as? String == "revoke" && revokeBody["session_id"] as? String == lease, "Revoke changed lease ID")
        try http.reply(["ok": true]); try failure("cloud_http_error") { _ = try settled!.get() }
        cases.append("checkpoint_failure_still_revokes_original_lease_and_surfaces_error")
        let invalidLease = UUID().uuidString
        grant = nil
        broker.issueModel(binding: original, agentId: agent, sessionId: session, modelId: "catalog-id", recordLease: { id in
            _ = try store.admit("leases", id: id, fingerprint: session) { ["status": "cleanup-required"] }
        }) { grant = $0 }
        try http.reply(["session_id": invalidLease, "protocol": "unsupported"])
        try require(try store.record("leases", id: invalidLease) != nil && http.pending.count == 1, "Invalid grant lost cleanup custody")
        try http.reply(["ok": true])
        try failure("invalid_model_lease") { _ = try grant!.get() }
        cases.append("invalid_grant_records_original_ID_then_revokes_without_reissue")
        // Values come from the repository's actual Android stableId implementation.
        try require(try GuguIOSStableID.strings("phone-task-input", "a", "b", "c") == "d9c7cf29-fd1e-5048-a24f-1633daf92378", "Android stable-ID namespace mismatch")
        cases.append("Android_stable_ID_namespace_matches")
        let output: [String: Any] = ["kind": "macos_real_native_broker_with_synthetic_HTTP_and_APFS", "result": "pass", "cases": cases,
            "realModelCalls": 0, "realCloudHTTPCalls": 0, "realEventKitCalls": 0, "iosAppRuns": 0]
        print(String(decoding: try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
