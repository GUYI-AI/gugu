import Foundation

private func require(_ condition: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !condition() { throw GuguHostFailure(code: "lease_test_failed", message: text) }
}
private func awaitResult<T>(_ work: (@escaping (T) -> Void) -> Void) throws -> T {
    let semaphore = DispatchSemaphore(value: 0); var value: T?
    work { value = $0; semaphore.signal() }
    try require(semaphore.wait(timeout: .now() + 10) == .success, "Native model callback timed out")
    return value!
}
private final class ModelFixture: GuguModelCompleting {
    var bodies: [[String: Any]] = []
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        bodies.append(body); completion(["ok": true, "data": ["choices": [["message": ["role": "assistant", "content": "fixture"]]]]])
    }
    func cancel(id: String) {}
}
private final class Fixture {
    let binding: GuguIOSHostBinding, store: GuguIOSBackendStore
    let agentId = UUID().uuidString.lowercased(), sessionId = UUID().uuidString.lowercased()
    var actions: [String] = [], loseIssue = false, allowed = true
    let transport = ModelFixture()
    init(_ root: URL) throws {
        let owner = UUID().uuidString.lowercased(), installation = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
        store = try .init(root: root, binding: binding)
    }
    lazy var broker = try! GuguIOSCloudBroker(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
        guard self.allowed, expected == self.binding else { throw GuguHostFailure(code: "stale_context", message: "Synthetic owner retired") }
        return .init(binding: expected, accessToken: "synthetic-human-native-only", expiresAt: Date().addingTimeInterval(3600))
    }, send: { request, done in
        let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any], action = body["action"] as! String
        self.actions.append(action)
        if action == "issue" && self.loseIssue { done(nil, nil, URLError(.networkConnectionLost)); return }
        let reply: [String: Any] = action == "issue" ? ["session_id": UUID().uuidString.lowercased(), "protocol": "openai-chat-completions", "relay_url": "https://model.invalid/prefix", "token": "synthetic-model-native-only", "model": "wire-model", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))] : ["ok": true]
        done(try! JSONSerialization.data(withJSONObject: reply), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
    })
    func model() -> GuguIOSLeaseModel {
        .init(binding: binding, agentId: agentId, sessionId: sessionId, modelId: "catalog-id", broker: broker, store: store, check: {
            guard self.allowed else { throw GuguHostFailure(code: "stale_context", message: "Owner retired") }
        }, makeTransport: { lease in
            try require(lease.bearerToken == "synthetic-model-native-only" && lease.sessionId == self.sessionId, "Model transport got another scope")
            return self.transport
        })
    }
    func context() -> GuguHostContext { .init(ownerId: binding.ownerId, installationId: binding.installationId, agentUserId: agentId, sessionId: sessionId, jobId: UUID().uuidString.lowercased(), contextEpoch: UUID().uuidString, runtimeInstanceId: UUID().uuidString) }
}
@main struct HostLeaseTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), fixture = try Fixture(root.appendingPathComponent("normal"))
        let model = fixture.model(), context = fixture.context(), body: [String: Any] = ["model": "catalog-id", "stream": false, "messages": []]
        let first: [String: Any] = try awaitResult { model.complete(id: "first", context: context, body: body, completion: $0) }
        try require(first["ok"] as? Bool == true && fixture.actions == ["issue"], "Initial lease was not issued once")
        let second: [String: Any] = try awaitResult { model.complete(id: "second", context: context, body: body, completion: $0) }
        try require(second["ok"] as? Bool == true && fixture.actions == ["issue"] && fixture.transport.bodies.count == 2, "Second completion issued another lease")
        try require(fixture.transport.bodies.allSatisfy { $0["model"] as? String == "wire-model" }, "Catalog model was not mapped to issued wire model")
        var cases = ["one_short_lease_per_turn_and_native_wire_model_mapping"]
        let duplicate: [String: Any] = try awaitResult { model.complete(id: "second", context: context, body: body, completion: $0) }
        try require(duplicate["code"] as? String == "duplicate_conflict" && fixture.transport.bodies.count == 2, "Duplicate model request executed again")
        cases.append("duplicate_model_request_ID_never_reexecutes")
        let disk = try JSONSerialization.data(withJSONObject: fixture.store.snapshot())
        try require(disk.range(of: Data("synthetic-model-native-only".utf8)) == nil && disk.range(of: Data("synthetic-human-native-only".utf8)) == nil, "Credentials entered durable lease store")
        cases.append("lease_cleanup_IDs_persist_without_human_or_model_credentials")
        let settled: Result<Void, Error> = try awaitResult { model.finishTurn(jobId: context.jobId, completion: $0) }; _ = try settled.get()
        try require(fixture.actions == ["issue", "checkpoint", "revoke"], "Lease close did not checkpoint and revoke original ID")
        try require(try fixture.store.record("leases", id: "issue:\(context.jobId)")?["status"] as? String == "settled", "Known settlement was not durable")
        cases.append("turn_finish_checkpoints_revokes_and_persists_settlement")
        let next = fixture.context()
        let nextReply: [String: Any] = try awaitResult { model.complete(id: "third", context: next, body: body, completion: $0) }
        try require(nextReply["ok"] as? Bool == true && fixture.actions.filter { $0 == "issue" }.count == 2, "Next explicit task could not get its own lease")
        let stopped: Result<Void, Error> = try awaitResult { model.stop(completion: $0) }; _ = try stopped.get()
        cases.append("next_explicit_task_issues_after_previous_settlement_and_stop_settles")
        let uncertain = try Fixture(root.appendingPathComponent("unknown")); uncertain.loseIssue = true
        let unknownModel = uncertain.model(), unknownContext = uncertain.context()
        let lost: [String: Any] = try awaitResult { unknownModel.complete(id: "lost", context: unknownContext, body: body, completion: $0) }
        try require(lost["code"] as? String == "cloud_transport_uncertain", "Lost issue reply was reported successful")
        let retried: [String: Any] = try awaitResult { unknownModel.complete(id: "retry", context: unknownContext, body: body, completion: $0) }
        try require(retried["code"] as? String == "model_issue_uncertain" && uncertain.actions == ["issue"], "Uncertain model issue was resent")
        cases.append("lost_issue_reply_is_durable_and_is_not_reissued")
        let blocked: Result<Void, Error> = try awaitResult { unknownModel.stop(completion: $0) }
        guard case .failure(let error as GuguHostFailure) = blocked, error.code == "model_cleanup_pending" else { throw GuguHostFailure(code: "lease_test_failed", message: "Unresolved issue reported clean retirement") }
        cases.append("unresolved_issue_does_not_report_successful_retirement")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["kind": "native_model_lease_lifecycle_APFS_with_synthetic_broker_and_model", "result": "pass", "cases": cases, "realModelCalls": 0, "realCloudHTTPCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
