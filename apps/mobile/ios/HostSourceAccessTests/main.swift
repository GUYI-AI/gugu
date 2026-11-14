import Foundation

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "source_access_test_failed", message: text) }
}
private func wait(_ work: (@escaping (Result<Void, Error>) -> Void) -> Void) throws -> Result<Void, Error> {
    let semaphore = DispatchSemaphore(value: 0); var outcome: Result<Void, Error>?
    work { outcome = $0; semaphore.signal() }
    try require(semaphore.wait(timeout: .now() + 10) == .success, "Native source callback timed out"); return outcome!
}
private final class Fixture {
    let binding: GuguIOSHostBinding, store: GuguIOSBackendStore, old: GuguHostContext, next: GuguHostContext
    let chat = UUID().uuidString.lowercased(), anotherChat = UUID().uuidString.lowercased(), started = DispatchSemaphore(value: 0)
    var allowed = true, revoked = false, moved = false, hold = false, held: (() -> Void)?, readAs: [String] = []
    init(_ root: URL) throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased(), agent = UUID().uuidString.lowercased(), session = UUID().uuidString.lowercased(), epoch = UUID().uuidString.lowercased(), runtime = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        old = .init(ownerId: owner, installationId: install, agentUserId: agent, sessionId: session, jobId: UUID().uuidString.lowercased(), contextEpoch: epoch, runtimeInstanceId: runtime)
        next = .init(ownerId: owner, installationId: install, agentUserId: agent, sessionId: session, jobId: UUID().uuidString.lowercased(), contextEpoch: epoch, runtimeInstanceId: runtime)
        store = try .init(root: root, binding: binding)
        _ = try store.admit("agents", id: agent, fingerprint: "fixture") { ["ownerId": owner, "deviceId": binding.deviceId, "agentUserId": agent, "sessionId": session, "contextEpoch": epoch] }
        for context in [old, next] { _ = try store.admit("inputs", id: context.jobId, fingerprint: context.jobId) { ["agentId": agent, "sessionId": session, "contextEpoch": epoch, "status": "running"] } }
    }
    lazy var broker = try! GuguIOSCloudBroker(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
        guard self.allowed, expected == self.binding else { throw GuguHostFailure(code: "stale_context", message: "Synthetic publication retired") }
        return .init(binding: expected, accessToken: "synthetic-native-only", expiresAt: Date().addingTimeInterval(3600))
    }, send: { request, done in
        let name = request.url!.lastPathComponent, body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var raw: Any = NSNull()
        if name == "active_users" { raw = [["id": self.old.agentUserId, "type": "agent", "owner_user_id": self.binding.ownerId, "device_id": self.moved ? "another-device" : self.binding.deviceId]] }
        if name == "list_member_ids" {
            self.readAs.append(body["p_as_user_id"] as? String ?? "")
            raw = self.revoked && body["p_chat_id"] as? String == self.chat ? [] : [["user_id": self.old.agentUserId]]
        }
        let value = raw
        let finish = { done(try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil) }
        if name == "list_member_ids", self.hold { self.hold = false; self.held = finish; self.started.signal() } else { finish() }
    })
    func access() -> GuguIOSSourceAccess { .init(store: store, broker: broker, check: { guard self.allowed else { throw GuguHostFailure(code: "stale_context", message: "Synthetic native publication retired") } }) }
}
@main struct HostSourceAccessTests {
    static func main() throws {
        let f = try Fixture(URL(fileURLWithPath: CommandLine.arguments[1])), access = f.access()
        try access.includeChat(f.chat, context: f.old)
        try require((try f.store.record("inputs", id: f.old.jobId)?["usedChatIds"] as? [String]) == [f.chat] && (try f.store.record("agents", id: f.old.agentUserId)?["usedChatIds"] as? [String]) == [f.chat], "Chat source was not atomically retained on input and continued context")
        _ = try wait { access.authorize(f.next, completion: $0) }.get()
        f.revoked = true
        let revoked = try wait { f.access().authorize(f.next, completion: $0) }
        guard case .failure(let error as GuguHostFailure) = revoked, error.code == "not_granted" else { throw GuguHostFailure(code: "source_access_test_failed", message: "Next turn ignored revoked previous chat source") }
        var cases = ["prior_turn_chat_lineage_is_persisted_and_rechecked_for_continued_turns"]
        f.revoked = false; f.moved = true
        let moved = try wait { access.authorizeSession(agentId: f.old.agentUserId, sessionId: f.old.sessionId, contextEpoch: f.old.contextEpoch, completion: $0) }
        guard case .failure(let error as GuguHostFailure) = moved, error.code == "not_granted" else { throw GuguHostFailure(code: "source_access_test_failed", message: "Moved Agent authorized old transcript") }
        f.moved = false
        cases.append("cloud_Agent_move_blocks_model_and_timeline_source_authorization")
        f.hold = true
        let finished = DispatchSemaphore(value: 0); var outcome: Result<Void, Error>?
        access.authorize(f.next) { outcome = $0; finished.signal() }
        try require(f.started.wait(timeout: .now() + 5) == .success, "Synthetic source request was not held")
        try access.includeChat(f.anotherChat, context: f.next); f.held?(); f.held = nil
        try require(finished.wait(timeout: .now() + 10) == .success, "Changed-lineage authorization did not return")
        guard case .failure(let error as GuguHostFailure) = outcome!, error.code == "stale_context" else { throw GuguHostFailure(code: "source_access_test_failed", message: "Newly added source bypassed in-flight source authorization") }
        _ = try wait { access.authorize(f.next, completion: $0) }.get()
        cases.append("in_flight_source_set_change_fails_then_explicit_full_recheck_succeeds")
        let beforeForeign = try GuguHostJournal.digest(f.store.snapshot())
        let foreign = GuguHostContext(ownerId: UUID().uuidString.lowercased(), installationId: f.next.installationId, agentUserId: f.next.agentUserId, sessionId: f.next.sessionId, jobId: f.next.jobId, contextEpoch: f.next.contextEpoch, runtimeInstanceId: f.next.runtimeInstanceId)
        do { try access.includeChat(f.anotherChat, context: foreign); throw GuguHostFailure(code: "source_access_test_failed", message: "Foreign owner appended a source") }
        catch let error as GuguHostFailure { try require(error.code == "stale_context", "Foreign source mutation failed for another reason") }
        try require(try GuguHostJournal.digest(f.store.snapshot()) == beforeForeign, "Rejected foreign lineage mutation changed durable state")
        cases.append("foreign_owner_source_mutation_has_zero_durable_side_effects")
        try f.store.update("agents", id: f.old.agentUserId) { $0["usedChatIds"] = "unreadable-lineage" }
        let malformed = try wait { access.authorize(f.next, completion: $0) }
        guard case .failure(let error as GuguHostFailure) = malformed, error.code == "invalid_journal" else { throw GuguHostFailure(code: "source_access_test_failed", message: "Unreadable source set was treated as empty") }
        try f.store.update("agents", id: f.old.agentUserId) { $0["usedChatIds"] = [f.chat, f.anotherChat]; $0["agentUserId"] = UUID().uuidString.lowercased() }
        let replaced = try wait { access.authorize(f.next, completion: $0) }
        guard case .failure(let error as GuguHostFailure) = replaced, error.code == "stale_context" else { throw GuguHostFailure(code: "source_access_test_failed", message: "Registry key authorized a different stored Agent identity") }
        try f.store.update("agents", id: f.old.agentUserId) { $0["agentUserId"] = f.old.agentUserId }
        cases.append("malformed_lineage_and_replaced_registry_identity_fail_closed")
        f.hold = true
        access.authorize(f.next) { outcome = $0; finished.signal() }
        try require(f.started.wait(timeout: .now() + 5) == .success, "Synthetic retiring source request was not held")
        f.allowed = false; f.held?(); f.held = nil
        try require(finished.wait(timeout: .now() + 10) == .success, "Retired source callback did not return")
        guard case .failure(let error as GuguHostFailure) = outcome!, error.code == "stale_context" else { throw GuguHostFailure(code: "source_access_test_failed", message: "Retired native publication delivered source authorization") }
        try require(f.readAs.allSatisfy { $0 == f.old.agentUserId }, "Source reads substituted owner identity for Agent")
        cases.append("retirement_during_source_read_rejects_late_authorization_and_all_reads_are_Agent_as")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "native_source_lineage_APFS_with_synthetic_Agent_as_HTTP", "cases": cases, "realCloudHTTPCalls": 0, "realModelCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
