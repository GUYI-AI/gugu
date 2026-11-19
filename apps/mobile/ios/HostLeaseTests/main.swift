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
    var actions: [String] = [], loseIssue = false, allowed = true, credentialReads = 0
    var holdAction: String?, held: (() -> Void)?
    let entered = DispatchSemaphore(value: 0)
    let transport = ModelFixture()
    init(_ root: URL) throws {
        let owner = UUID().uuidString.lowercased(), installation = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
        store = try .init(root: root, binding: binding)
    }
    lazy var broker = try! GuguIOSCloudBroker(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
        self.credentialReads += 1
        guard self.allowed, expected == self.binding else { throw GuguHostFailure(code: "stale_context", message: "Synthetic owner retired") }
        return .init(binding: expected, accessToken: "synthetic-human-native-only", expiresAt: Date().addingTimeInterval(3600))
    }, send: { request, done in
        let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any], action = body["action"] as! String
        self.actions.append(action)
        if action == "issue" && self.loseIssue { done(nil, nil, URLError(.networkConnectionLost)); return }
        let reply: [String: Any] = action == "issue" ? ["session_id": UUID().uuidString.lowercased(), "protocol": "openai-chat-completions", "relay_url": "https://model.invalid/prefix", "token": "synthetic-model-native-only", "model": "wire-model", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))] : ["ok": true]
        let finish = { done(try! JSONSerialization.data(withJSONObject: reply), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil) }
        if self.holdAction == action { self.held = finish; self.entered.signal() } else { finish() }
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
        let sealed = try Fixture(root.appendingPathComponent("external-cleanup")), sealedModel = sealed.model(), sealedContext = sealed.context()
        let issued: [String: Any] = try awaitResult { sealedModel.complete(id: "sealed-first", context: sealedContext, body: body, completion: $0) }
        try require(issued["ok"] as? Bool == true, "External retirement fixture did not issue")
        let quiet: Result<Void, Error> = try awaitResult { sealedModel.quiesce(completion: $0) }; _ = try quiet.get()
        let reads = sealed.credentialReads; sealed.allowed = false
        let pending: Result<Void, Error> = try awaitResult { sealedModel.finishTurn(jobId: sealedContext.jobId, completion: $0) }
        guard case .failure(let pendingError as GuguHostFailure) = pending, pendingError.code == "model_cleanup_pending" else { throw GuguHostFailure(code: "lease_test_failed", message: "Quiesced finish hid pending cleanup") }
        try require(sealed.credentialReads == reads && sealed.actions == ["issue"], "Quiesced finish borrowed ordinary credentials")
        cases.append("external_quiescence_and_late_turn_finish_request_zero_ordinary_credentials")
        try sealed.store.update("leases", id: "issue:\(sealedContext.jobId)") { $0["status"] = "settled" }
        let cleaned: Result<Void, Error> = try awaitResult { sealedModel.finishTurn(jobId: sealedContext.jobId, completion: $0) }; _ = try cleaned.get()
        try require(sealed.credentialReads == reads && (try sealed.store.record("leases", id: "issue:\(sealedContext.jobId)"))?["status"] as? String == "settled", "Late finish downgraded native cleanup receipt")
        cases.append("late_finish_preserves_external_known_settlement_without_ordinary_HTTP")
        let racing = try Fixture(root.appendingPathComponent("late-old-checkpoint")), racingModel = racing.model(), racingContext = racing.context()
        let racingIssue: [String: Any] = try awaitResult { racingModel.complete(id: "race-first", context: racingContext, body: body, completion: $0) }; try require(racingIssue["ok"] as? Bool == true, "Race fixture did not issue")
        racing.holdAction = "checkpoint"
        let finished = DispatchSemaphore(value: 0); var oldFinish: Result<Void, Error>?
        racingModel.finishTurn(jobId: racingContext.jobId) { oldFinish = $0; finished.signal() }
        try require(racing.entered.wait(timeout: .now() + 10) == .success, "Old ordinary checkpoint was not held")
        let raceQuiet: Result<Void, Error> = try awaitResult { racingModel.quiesce(completion: $0) }; _ = try raceQuiet.get()
        racing.allowed = false; try racing.store.update("leases", id: "issue:\(racingContext.jobId)") { $0["status"] = "settled" }
        racing.held?(); racing.held = nil
        try require(finished.wait(timeout: .now() + 10) == .success, "Old settlement callback did not finish")
        guard case .failure = oldFinish! else { throw GuguHostFailure(code: "lease_test_failed", message: "Retired old checkpoint unexpectedly succeeded") }
        try require((try racing.store.record("leases", id: "issue:\(racingContext.jobId)"))?["status"] as? String == "settled" && racing.actions == ["issue", "checkpoint"], "Late ordinary failure erased external known receipt or sent another request")
        cases.append("held_old_settlement_failure_cannot_downgrade_external_terminal_receipt")
        let lateGrant = try Fixture(root.appendingPathComponent("late-old-issue")); lateGrant.holdAction = "issue"
        let grantModel = lateGrant.model(), grantContext = lateGrant.context(), grantDone = DispatchSemaphore(value: 0)
        grantModel.complete(id: "held-issue", context: grantContext, body: body) { _ in grantDone.signal() }
        try require(lateGrant.entered.wait(timeout: .now() + 10) == .success, "Original issue was not held")
        let grantQuiet: Result<Void, Error> = try awaitResult { grantModel.quiesce(completion: $0) }
        guard case .failure = grantQuiet else { throw GuguHostFailure(code: "lease_test_failed", message: "In-flight issue was reported locally resolved") }
        try require(grantDone.wait(timeout: .now() + 10) == .success, "Quiescence did not cancel pending model reply")
        lateGrant.held?(); lateGrant.held = nil
        let lateFinish: Result<Void, Error> = try awaitResult { grantModel.finishTurn(jobId: grantContext.jobId, completion: $0) }
        guard case .failure = lateFinish else { throw GuguHostFailure(code: "lease_test_failed", message: "Late grant was silently settled") }
        try require(lateGrant.actions == ["issue"] && lateGrant.transport.bodies.isEmpty && (try lateGrant.store.record("leases", id: "issue:\(grantContext.jobId)"))?["leaseId"] is String, "Late grant inferred or automatically settled after external retirement")
        cases.append("late_original_issue_records_known_lease_but_never_infers_or_auto_settles_after_quiescence")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["kind": "native_model_lease_lifecycle_APFS_with_synthetic_broker_and_model", "result": "pass", "cases": cases, "realModelCalls": 0, "realCloudHTTPCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
