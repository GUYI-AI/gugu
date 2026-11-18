import Foundation
import CryptoKit

func check(_ condition: Bool) { precondition(condition) }
func expect(_ code: String, _ work: () throws -> Void) throws {
    do { try work(); throw GuguHostFailure(code: "test_failed", message: "Expected \(code)") }
    catch let error as GuguHostFailure { precondition(error.code == code, "expected \(code), got \(error)") }
}
func binding(owner: String, install: String, runtime: String = UUID().uuidString) -> GuguHostContext {
    GuguHostContext(ownerId: owner, installationId: install, agentUserId: UUID().uuidString,
        sessionId: UUID().uuidString, jobId: UUID().uuidString, contextEpoch: UUID().uuidString, runtimeInstanceId: runtime)
}
func wait(_ semaphore: DispatchSemaphore) throws {
    guard semaphore.wait(timeout: .now() + 10) == .success else { throw GuguHostFailure(code: "test_timeout", message: "Timed out waiting for the local bridge") }
}
final class FixtureCalendar: GuguNativeToolExecutor {
    var reads = 0
    var writes = 0
    var granted = true
    func validateAccess(_ control: GuguNativeToolControl) throws {
        try control.checkActive()
        if !granted { throw GuguHostFailure(code: "not_granted", message: "Fixture calendar permission is revoked") }
    }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        do {
            try control.checkActive()
            if request.actionName == "calendar.events.list" {
                reads += 1
                completion(["ok": true, "data": ["events": [], "timezone": "Asia/Shanghai", "fixture": true]])
            } else {
                try control.beginMutation()
                writes += 1
                let result: [String: Any] = ["ok": true, "data": ["event_id": "fixture-event-1", "fixture": true]]
                try control.finishMutation(result["data"] as! [String: Any])
                try control.checkActive()
                completion(result)
            }
        } catch { completion((error as? GuguHostFailure ?? GuguHostFailure(code: "fixture_failed", message: "Fixture failed")).envelope) }
    }
}
final class FixtureModel: GuguModelCompleting {
    var calls = 0
    var cancellations = 0
    var held: (([String: Any]) -> Void)?
    let mode: String
    let started = DispatchSemaphore(value: 0)
    init(_ mode: String) { self.mode = mode }
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        if mode == "held" { held = completion; started.signal(); return }
        let name = mode == "write" ? "phone_calendar_create" : "phone_calendar_list"
        let args = mode == "write" ? "{\"title\":\"Fixture only\",\"start\":\"2026-11-08T12:00:00+08:00\"}" : "{\"date\":\"2026-11-08\"}"
        let message: [String: Any] = calls == 1
            ? ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "fixture-call-1", "type": "function", "function": ["name": name, "arguments": args]]]]
            : ["role": "assistant", "content": "Fixture completed"]
        completion(["ok": true, "data": ["choices": [["finish_reason": calls == 1 ? "tool_calls" : "stop", "message": message]]]])
    }
    func cancel(id: String) { cancellations += 1 }
}

@main struct HostStateTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true).appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let owner = UUID().uuidString, install = UUID().uuidString
        let journal = try GuguHostJournal(root: root, ownerId: owner, installationId: install)
        let context = binding(owner: owner, install: install)
        check(try journal.admit(context, prompt: "fixture", modelId: "fixture"))
        check(try !journal.admit(context, prompt: "fixture", modelId: "fixture"))
        try expect("duplicate_conflict") { _ = try journal.admit(context, prompt: "different", modelId: "fixture") }
        let deadline = Int64(Date().timeIntervalSince1970 * 1000) + 60000
        let (write, _) = try journal.admitTool(context, toolCallId: "write", action: "calendar.events.create", arguments: ["title": "fixture"], deadlineAtMs: deadline)
        precondition(write.argumentsSHA256 == SHA256.hash(data: Data(write.argumentsJSON.utf8)).map { String(format: "%02x", $0) }.joined())
        try expect("not_granted") { try journal.beginMutation(write) }
        try journal.record(context, event: ["type": "message_end"], messages: [["role": "assistant", "content": [["type": "toolCall", "id": "write", "name": "phone_calendar_create", "arguments": ["title": "fixture"]]]]])
        try journal.approve(write)
        try journal.beginMutation(write)
        try expect("not_granted") { try journal.beginMutation(write) }
        try expect("duplicate_conflict") { _ = try journal.admitTool(context, toolCallId: "write", action: "calendar.events.create", arguments: ["title": "changed"], deadlineAtMs: deadline) }
        let reopened = try GuguHostJournal(root: root, ownerId: owner, installationId: install)
        check(try reopened.job(context.jobId)["status"] as? String == "interrupted")
        let dataURL = root.appendingPathComponent(owner).appendingPathComponent("host.json")
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: dataURL)) as! [String: Any]
        let calls = raw["calls"] as! [String: [String: Any]]
        precondition(calls[write.requestId]?["status"] as? String == "execution_unknown")
        precondition(calls[write.requestId]?["receipt"] == nil)
        let recovery = try reopened.continuationTranscript(jobId: context.jobId)
        precondition(recovery.count == 2 && recovery[1]["role"] as? String == "toolResult")
        let recoveryText = (recovery[1]["content"] as? [[String: Any]])?[0]["text"] as! String
        check(try GuguJavaScriptRuntime.object(recoveryText)["code"] as? String == "execution_unknown")
        try expect("stale_context") { _ = try GuguHostJournal(root: root, ownerId: owner, installationId: UUID().uuidString) }
        let second = binding(owner: owner, install: install)
        check(try reopened.admit(second, prompt: "second", modelId: "fixture"))
        let (late, _) = try reopened.admitTool(second, toolCallId: "late", action: "calendar.events.create", arguments: ["title": "late"], deadlineAtMs: deadline)
        try reopened.approve(late); try reopened.beginMutation(late); try reopened.cancel(second)
        try reopened.finishMutation(late, result: ["event_id": "known-late-fixture"])
        check(try reopened.job(second.jobId)["status"] as? String == "cancelled")
        let moved = root.appendingPathComponent(owner + "-moved")
        try FileManager.default.moveItem(at: root.appendingPathComponent(owner), to: moved)
        let third = binding(owner: owner, install: install)
        do { _ = try reopened.admit(third, prompt: "must not ack", modelId: "fixture"); preconditionFailure("write failure was acknowledged") } catch { }
        try FileManager.default.moveItem(at: moved, to: root.appendingPathComponent(owner))
        check(try reopened.admit(third, prompt: "must not ack", modelId: "fixture"))

        let asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let hash = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        var receipts: [[String: Any]] = []
        for mode in ["read", "write", "held", "missing-ticket"] {
            let taskRoot = root.appendingPathComponent(mode)
            let taskJournal = try GuguHostJournal(root: taskRoot, ownerId: owner, installationId: install)
            let fixtureModel = FixtureModel(mode)
            let calendar = FixtureCalendar()
            let done = DispatchSemaphore(value: 0), needsApproval = DispatchSemaphore(value: 0)
            var requestId: String?
            let host = try GuguInProcessHost(asset: asset, expectedSHA256: hash, journal: taskJournal, executor: calendar,
                model: mode == "missing-ticket" ? nil : fixtureModel, currentIdentity: { (owner, install) }, event: { event in
                    if event["type"] as? String == "confirmation_pending" { requestId = event["requestId"] as? String; needsApproval.signal() }
                    if event["type"] as? String == "task_status" { done.signal() }
                })
            let context = binding(owner: owner, install: install, runtime: host.runtimeInstanceId)
            let action = mode == "write" ? "calendar.events.create" : "calendar.events.list"
            let name = mode == "write" ? "phone_calendar_create" : "phone_calendar_list"
            _ = try host.start(context: context, prompt: "fixture", modelId: "fixture", systemPrompt: "Fixture only", tools: [["name": name, "actionName": action]])
            if mode == "write" {
                try wait(needsApproval)
                precondition(calendar.writes == 0)
                try expect("not_granted") { try host.approve(requestId: requestId!, nativeOwnerId: UUID().uuidString) }
                try host.approve(requestId: requestId!, nativeOwnerId: owner)
                try expect("not_granted") { try host.approve(requestId: requestId!, nativeOwnerId: owner) }
            }
            if mode == "held" {
                try wait(fixtureModel.started)
                try host.cancel(context: context)
                fixtureModel.held?(["ok": true, "data": ["choices": [["finish_reason": "stop", "message": ["content": "late old result"]]]]])
            }
            try wait(done)
            let job = try taskJournal.job(context.jobId)
            let expected = mode == "held" ? "cancelled" : mode == "missing-ticket" ? "failed" : "done"
            precondition(job["status"] as? String == expected, "\(mode): \(job)")
            precondition(calendar.writes == (mode == "write" ? 1 : 0))
            precondition(calendar.reads == (mode == "read" ? 1 : 0))
            precondition(fixtureModel.calls == (mode == "held" ? 1 : mode == "missing-ticket" ? 0 : 2))
            receipts.append(["mode": mode, "status": expected, "fixtureModelCalls": fixtureModel.calls, "fixtureCalendarReads": calendar.reads, "fixtureCalendarWrites": calendar.writes])
            _ = try host.readTask(jobId: context.jobId)
            try host.stop()
            if mode == "read" {
                let restored = try GuguHostJournal(root: taskRoot, ownerId: owner, installationId: install)
                let model2 = FixtureModel("read"), calendar2 = FixtureCalendar()
                let done2 = DispatchSemaphore(value: 0)
                let host2 = try GuguInProcessHost(asset: asset, expectedSHA256: hash, journal: restored,
                    executor: calendar2, model: model2, currentIdentity: { (owner, install) }, event: { event in
                        if event["type"] as? String == "task_status" { done2.signal() }
                    })
                precondition(model2.calls == 0 && calendar2.reads == 0, "Initialization must not resume work")
                let next = GuguHostContext(ownerId: owner, installationId: install, agentUserId: context.agentUserId,
                    sessionId: context.sessionId, jobId: UUID().uuidString, contextEpoch: context.contextEpoch, runtimeInstanceId: host2.runtimeInstanceId)
                _ = try host2.continueTask(previousJobId: context.jobId, context: next, prompt: "Explicitly continue", modelId: "fixture", systemPrompt: "Fixture only", tools: [["name": name, "actionName": action]])
                try wait(done2)
                precondition(model2.calls == 2 && calendar2.reads == 1)
                check(try restored.job(next.jobId)["status"] as? String == "done")
                calendar2.granted = false
                try expect("not_granted") { _ = try host2.readTask(jobId: next.jobId) }
                calendar2.granted = true
                try expect("not_granted") { _ = try host2.readTask(jobId: next.jobId) }
                let stale = GuguHostContext(ownerId: owner, installationId: install, agentUserId: next.agentUserId,
                    sessionId: next.sessionId, jobId: UUID().uuidString, contextEpoch: next.contextEpoch, runtimeInstanceId: next.runtimeInstanceId)
                try expect("not_granted") { _ = try host2.start(context: stale, prompt: "Cannot reuse revoked context", modelId: "fixture", systemPrompt: "Fixture only", tools: [["name": name, "actionName": action]]) }
                receipts.append(["mode": "restart_explicit_continuation_and_revocation", "status": "done", "fixtureModelCalls": model2.calls, "fixtureCalendarReads": calendar2.reads, "automaticResumeCalls": 0])
                try host2.stop()
            }
        }
        print(try GuguJavaScriptRuntime.json(["result": "pass", "kind": "native_journal_and_jsc_fixture_only", "journalCases": 9, "coordinatorCases": receipts, "realModelCalls": 0, "realEventKitCalls": 0]))
    }
}
