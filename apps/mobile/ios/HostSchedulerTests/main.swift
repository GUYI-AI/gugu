import Foundation
import CryptoKit

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "scheduler_test_failed", message: text) }
}
private func awaitResult<T>(_ work: (@escaping (T) -> Void) -> Void) throws -> T {
    let wait = DispatchSemaphore(value: 0); var value: T?
    work { value = $0; wait.signal() }; try require(wait.wait(timeout: .now() + 10) == .success, "Native scheduler callback timed out"); return value!
}
private final class CalendarFixture: GuguNativeToolExecutor {
    var writes = 0
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        do {
            try control.checkActive()
            if request.actionName != "calendar.events.list" { try control.beginMutation(); writes += 1; try control.finishMutation(["event_id": "synthetic-event"]) }
            completion(["ok": true, "data": ["events": [], "fixture": true]])
        } catch { completion((error as? GuguHostFailure ?? .init(code: "fixture", message: "Calendar fixture failed")).envelope) }
    }
}
private final class ModelFixture: GuguModelCompleting {
    var calls = 0, held = false, write = false
    let started = DispatchSemaphore(value: 0)
    var heldReply: (([String: Any]) -> Void)?
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        if held { heldReply = completion; started.signal(); return }
        let messages = body["messages"] as! [[String: Any]], hasTool = messages.contains { $0["role"] as? String == "tool" }
        let message: [String: Any] = write && !hasTool ? ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "fixture-exact-call", "type": "function", "function": ["name": "calendar_create", "arguments": "{\"title\":\"Fixture only\",\"start\":\"2026-11-08T12:00:00+08:00\"}"]]]] : ["role": "assistant", "content": "Fixture Pi completed"]
        completion(["ok": true, "data": ["choices": [["finish_reason": write && !hasTool ? "tool_calls" : "stop", "message": message]]]])
    }
    func cancel(id: String) { heldReply = nil }
}
private final class Fixture {
    let binding: GuguIOSHostBinding, store: GuguIOSBackendStore, lifecycle: GuguIOSHostLifecycle, runtime: GuguPackagedRuntime
    let agentId = UUID().uuidString.lowercased(), sessionId = UUID().uuidString.lowercased(), calendar = CalendarFixture(), model = ModelFixture(), changed = DispatchSemaphore(value: 0)
    var actions: [String] = [], allowed = true
    init(_ root: URL, asset: Data) throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        store = try .init(root: root.appendingPathComponent("backend"), binding: binding)
        runtime = .init(asset: asset, sha256: SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined(), piVersion: "1.4.0")
        let captured = binding
        lifecycle = .init(root: root.appendingPathComponent("host"), verifiedIdentity: { captured })
        _ = try store.admit("agents", id: agentId, fingerprint: "synthetic-cloud-command") {
            ["ownerId": binding.ownerId, "deviceId": binding.deviceId, "agentUserId": agentId, "sessionId": sessionId, "contextEpoch": UUID().uuidString.lowercased(), "modelId": "catalog-id", "displayName": "fixture", "status": "idle", "chatId": UUID().uuidString]
        }
    }
    var agent: [String: Any] { get throws { try store.record("agents", id: agentId)! } }
    lazy var broker = try! GuguIOSCloudBroker(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
        guard self.allowed else { throw GuguHostFailure(code: "stale_context", message: "Synthetic owner retired") }
        return .init(binding: expected, accessToken: "synthetic-human", expiresAt: Date().addingTimeInterval(3600))
    }, send: { request, done in
        let body = try! JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any], action = body["action"] as! String; self.actions.append(action)
        let reply: [String: Any] = action == "issue" ? ["session_id": UUID().uuidString.lowercased(), "protocol": "openai-chat-completions", "relay_url": "https://model.invalid", "token": "synthetic-short-token", "model": "wire-model", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))] : ["ok": true]
        done(try! JSONSerialization.data(withJSONObject: reply), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
    })
    func scheduler() throws -> GuguIOSTaskScheduler {
        try .open(store: store, lifecycle: lifecycle, runtime: runtime, broker: broker, check: {
            guard self.allowed else { throw GuguHostFailure(code: "stale_context", message: "Native fixture owner retired") }
        }, executor: { self.calendar }, changed: { self.changed.signal() }, modelTransport: { _ in self.model })
    }
    func waitStatus(_ id: String, _ expected: String) throws {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if try store.record("inputs", id: id)?["status"] as? String == expected { return }
            _ = changed.wait(timeout: .now() + 0.1)
        }
        throw GuguHostFailure(code: "scheduler_test_failed", message: "Input did not reach \(expected): \(try store.record("inputs", id: id) ?? [:])")
    }
}
@main struct HostSchedulerTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let f = try Fixture(root.appendingPathComponent("normal"), asset: asset), scheduler = try f.scheduler()
        let established: Result<Void, Error> = try awaitResult { scheduler.establish(try! f.agent, completion: $0) }; _ = try established.get()
        try require(f.model.calls == 0 && f.actions.isEmpty, "Constructing a session started inference")
        var cases = ["real_Pi_JSC_session_construction_performs_zero_inference"]
        let id = UUID().uuidString.lowercased(), client = UUID().uuidString.lowercased()
        let admitted: Result<Void, Error> = try awaitResult { scheduler.admit(agent: try! f.agent, text: "fixture input", id: id, clientMessageId: client, completion: $0) }; _ = try admitted.get()
        try f.waitStatus(id, "done")
        let journal = try f.lifecycle.journal(binding: f.binding), job = try journal.job(id)
        try require(job["clientMessageId"] as? String == client && (job["events"] as? [[String: Any]])?.isEmpty == false, "Original client ID or actual Pi events missing")
        let timeline: [String: Any] = try awaitResult { scheduler.timeline(agent: try! f.agent, method: "snapshot", input: ["trim": false], completion: $0) }
        let timelineJSON = String(decoding: try JSONSerialization.data(withJSONObject: timeline), as: UTF8.self)
        try require(timeline["ok"] as? Bool == true && timelineJSON.contains(client) && timelineJSON.contains("Fixture Pi completed"), "Real native timeline lacks original client ID or Pi answer")
        cases.append("durable_input_runs_real_Pi_and_shared_timeline_preserves_client_ID")
        let replay: Result<Void, Error> = try awaitResult { scheduler.admit(agent: try! f.agent, text: "fixture input", id: id, clientMessageId: client, completion: $0) }; _ = try replay.get()
        try require(f.model.calls == 1, "Duplicate accepted input executed again")
        let changed: Result<Void, Error> = try awaitResult { scheduler.admit(agent: try! f.agent, text: "changed", id: id, clientMessageId: client, completion: $0) }
        guard case .failure(let error as GuguHostFailure) = changed, error.code == "duplicate_conflict" else { throw GuguHostFailure(code: "scheduler_test_failed", message: "Changed duplicate input was accepted") }
        cases.append("same_input_ID_replays_custody_and_changed_body_rejects")
        let second = UUID().uuidString.lowercased()
        let next: Result<Void, Error> = try awaitResult { scheduler.admit(agent: try! f.agent, text: "explicit next input", id: second, completion: $0) }; _ = try next.get(); try f.waitStatus(second, "done")
        try require(f.model.calls == 2 && (try journal.job(second)["messages"] as? [[String: Any]])?.count ?? 0 >= 4, "Explicit next turn did not continue actual saved Pi transcript")
        cases.append("next_explicit_input_continues_durable_Pi_transcript")
        let stop: Result<Void, Error> = try awaitResult { scheduler.stop(completion: $0) }; _ = try stop.get()

        let write = try Fixture(root.appendingPathComponent("write"), asset: asset); write.model.write = true
        let writeScheduler = try write.scheduler(), writeId = UUID().uuidString.lowercased()
        let writeAccepted: Result<Void, Error> = try awaitResult { writeScheduler.admit(agent: try! write.agent, text: "write fixture", id: writeId, completion: $0) }; _ = try writeAccepted.get(); try write.waitStatus(writeId, "needs_user")
        let pending: [String: Any] = try awaitResult { writeScheduler.timeline(agent: try! write.agent, method: "snapshot", input: ["trim": false], completion: $0) }
        let pendingJSON = String(decoding: try JSONSerialization.data(withJSONObject: pending), as: UTF8.self)
        let calls = try write.lifecycle.journal(binding: write.binding).calls(jobId: writeId), request = calls.first!["requestId"] as! String
        try require(request.count == 64 && pendingJSON.contains(request) && write.calendar.writes == 0, "Exact native approval was absent or write ran before approval")
        let declined: Result<[String: Any], Error> = try awaitResult { writeScheduler.respond(agent: try! write.agent, requestId: request, option: "cancel", completion: $0) }; _ = try declined.get(); try write.waitStatus(writeId, "done")
        try require(write.calendar.writes == 0, "Declining exact native approval wrote a calendar event")
        cases.append("real_Pi_pending_approval_uses_original_digest_and_decline_writes_zero")
        let settled: [String: Any] = try awaitResult { writeScheduler.timeline(agent: try! write.agent, method: "snapshot", input: ["trim": false], completion: $0) }
        let settledJSON = String(decoding: try JSONSerialization.data(withJSONObject: settled), as: UTF8.self)
        try require(settled["ok"] as? Bool == true && settledJSON.contains("resolved") && settledJSON.contains(request) && settledJSON.contains("reject_once"), "Persisted permission resolution disappeared from shared timeline")
        let repeated: Result<[String: Any], Error> = try awaitResult { writeScheduler.respond(agent: try! write.agent, requestId: request, option: "approve", completion: $0) }
        try require(try repeated.get()["accepted"] as? Bool == false && write.calendar.writes == 0, "Resolved rejection was converted into approval")
        cases.append("shared_timeline_retains_resolved_rejection_and_repeated_response_cannot_write")
        let stoppedWrite: Result<Void, Error> = try awaitResult { writeScheduler.stop(completion: $0) }; _ = try stoppedWrite.get()

        let approved = try Fixture(root.appendingPathComponent("approved"), asset: asset); approved.model.write = true
        let approvedScheduler = try approved.scheduler(), approvedId = UUID().uuidString.lowercased()
        let approvedInput: Result<Void, Error> = try awaitResult { approvedScheduler.admit(agent: try! approved.agent, text: "approve one exact fixture", id: approvedId, completion: $0) }; _ = try approvedInput.get(); try approved.waitStatus(approvedId, "needs_user")
        let approvedRequest = try approved.lifecycle.journal(binding: approved.binding).calls(jobId: approvedId).first!["requestId"] as! String
        let approvedResponse: Result<[String: Any], Error> = try awaitResult { approvedScheduler.respond(agent: try! approved.agent, requestId: approvedRequest, option: "approve", completion: $0) }; _ = try approvedResponse.get(); try approved.waitStatus(approvedId, "done")
        let duplicateApproval: Result<[String: Any], Error> = try awaitResult { approvedScheduler.respond(agent: try! approved.agent, requestId: approvedRequest, option: "approve", completion: $0) }
        try require(try duplicateApproval.get()["accepted"] as? Bool == false && approved.calendar.writes == 1, "Exact approval did not write once")
        let approvedStop: Result<Void, Error> = try awaitResult { approvedScheduler.stop(completion: $0) }; _ = try approvedStop.get()
        cases.append("exact_native_approval_runs_one_calendar_fixture_write_and_cannot_replay")

        let held = try Fixture(root.appendingPathComponent("held"), asset: asset); held.model.held = true
        let heldScheduler = try held.scheduler(), heldId = UUID().uuidString.lowercased()
        let heldAccepted: Result<Void, Error> = try awaitResult { heldScheduler.admit(agent: try! held.agent, text: "held fixture", id: heldId, completion: $0) }; _ = try heldAccepted.get()
        try require(held.model.started.wait(timeout: .now() + 10) == .success, "Real Pi did not reach held fixture transport")
        try require(try held.scheduler() === heldScheduler, "Second same-root facade replaced a live scheduler")
        try require(try held.store.record("inputs", id: heldId)?["status"] as? String == "running", "Second facade recovered a live input as interrupted")
        let cancelId = UUID().uuidString.lowercased()
        let cancel: Result<Bool, Error> = try awaitResult { heldScheduler.cancel(sessionId: held.sessionId, requestId: cancelId, completion: $0) }; _ = try cancel.get(); try held.waitStatus(heldId, "cancelled")
        let newHeldId = UUID().uuidString.lowercased()
        let newHeldInput: Result<Void, Error> = try awaitResult { heldScheduler.admit(agent: try! held.agent, text: "new held turn", id: newHeldId, completion: $0) }; _ = try newHeldInput.get()
        try require(held.model.started.wait(timeout: .now() + 10) == .success, "New held turn did not start")
        let repeatedCancel: Result<Bool, Error> = try awaitResult { heldScheduler.cancel(sessionId: held.sessionId, requestId: cancelId, completion: $0) }; _ = try repeatedCancel.get()
        try require(try held.store.record("inputs", id: newHeldId)?["status"] as? String == "running", "Original cancellation replay cancelled a newer turn")
        cases.append("original_cancel_receipt_does_not_cancel_a_newer_turn_in_same_session")
        let heldStop: Result<Void, Error> = try awaitResult { heldScheduler.stop(completion: $0) }; _ = try heldStop.get()
        try require(try held.lifecycle.journal(binding: held.binding).job(heldId)["status"] as? String == "cancelled", "Stop did not persist native cancellation")
        cases.append("same_root_facade_reuses_live_custody_and_stop_cancels_real_Pi")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["kind": "actual_macOS_Pi_JSC_scheduler_APFS_synthetic_cloud_model_calendar", "result": "pass", "cases": cases, "realModelCalls": 0, "realCloudHTTPCalls": 0, "realEventKitCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
