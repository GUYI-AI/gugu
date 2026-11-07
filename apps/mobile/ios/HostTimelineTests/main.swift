import Foundation
import CryptoKit

final class TimelineModelFixture: GuguModelCompleting {
    var calls = 0
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        let message: [String: Any] = calls == 1
            ? ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "timeline-tool", "type": "function", "function": ["name": "phone_calendar_list", "arguments": "{\"date\":\"2026-11-08\"}"]]]]
            : ["role": "assistant", "content": "Fixture text after an explicit failed tool"]
        completion(["ok": true, "data": ["choices": [["finish_reason": calls == 1 ? "tool_calls" : "stop", "message": message]]]])
    }
    func cancel(id: String) {}
}
final class TimelineToolFixture: GuguNativeToolExecutor {
    var calls = 0
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        completion(["ok": false, "code": "invalid_args", "message": "Explicit failed calendar fixture"])
    }
}

@main struct HostTimelineTests {
    static func main() throws {
        let asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let digest = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        let root = URL(fileURLWithPath: CommandLine.arguments[2])
        let owner = UUID().uuidString, install = UUID().uuidString, session = UUID().uuidString, agent = UUID().uuidString, epoch = UUID().uuidString
        let journal = try GuguHostJournal(root: root, ownerId: owner, installationId: install)
        let done = DispatchSemaphore(value: 0), model = TimelineModelFixture(), tool = TimelineToolFixture()
        let host = try GuguInProcessHost(asset: asset, expectedSHA256: digest, journal: journal, executor: tool, model: model,
            currentIdentity: { (owner, install) }, event: { if $0["type"] as? String == "task_status" { done.signal() } })
        func context() -> GuguHostContext {
            GuguHostContext(ownerId: owner, installationId: install, agentUserId: agent, sessionId: session,
                jobId: UUID().uuidString, contextEpoch: epoch, runtimeInstanceId: host.runtimeInstanceId)
        }
        let first = context()
        _ = try host.start(context: first, prompt: "Timeline real Pi fixture", modelId: "no-network-fixture", systemPrompt: "fixture", tools: [
            ["name": "phone_calendar_list", "actionName": "calendar.events.list"],
        ])
        try wait(done)
        let firstJob = try host.readTask(jobId: first.jobId)
        try require(model.calls == 2 && tool.calls == 1, "Actual Pi loop did not complete the failed-tool cycle")
        let projection = try GuguJavaScriptRuntime(asset: asset, expectedSHA256: digest, request: { _, reply in reply(["ok": false, "code": "not_allowed"]) }, cancel: { _ in }, event: { _ in })
        var input: [String: Any] = ["key": "\(owner):\(install):\(session):\(epoch)", "sessionId": session, "jobs": [firstJob], "method": "snapshot", "trim": true]
        let snapshot = try project(projection, input)
        try JSONSerialization.data(withJSONObject: ["firstJob": firstJob, "snapshot": snapshot], options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
        try require(contains(snapshot, key: "status", value: "error"), "Final text hid the actual failed tool")
        try require(try GuguJavaScriptRuntime.json(snapshot).contains("Fixture text after an explicit failed tool"), "Actual assistant text was lost")
        let turns = snapshot["turns"] as? [[String: Any]] ?? []
        try require(turns.count == 1, "Actual Pi messages did not form one shared transcript turn")
        var cases = ["actual_pi_message_events_project_with_failed_tool_and_final_text"]
        let cursor = snapshot["cursor"] as! [String: Any]
        input["method"] = "after"; input["cursor"] = cursor
        let unchanged = try project(projection, input)
        try require(unchanged["ok"] as? Bool == true, "Same source lost its cursor")
        let batch = unchanged["batch"] as? [String: Any]
        try require((batch?["turns"] as? [Any])?.isEmpty == true, "Unchanged poll resent turns")
        cases.append("same_cursor_after_has_no_duplicate_turns")

        let second = context()
        _ = try host.start(context: second, prompt: "Second real Pi turn", modelId: "no-network-fixture", systemPrompt: "fixture", tools: [])
        try wait(done)
        let secondJob = try host.readTask(jobId: second.jobId)
        input["jobs"] = [firstJob, secondJob]
        let after = try project(projection, input)
        try require(after["ok"] as? Bool == true, "Appended real turn reset the existing source")
        input["method"] = "snapshot"
        let twoTurns = try project(projection, input)
        try require((twoTurns["turns"] as? [Any])?.count == 2, "Appended turn was lost or duplicated")
        cases.append("actual_second_turn_appends_without_source_reset")

        input["method"] = "after"; input["key"] = UUID().uuidString
        let cold = try project(projection, input)
        try require(cold["ok"] as? Bool == false && cold["snapshot"] != nil, "Cold projection accepted a cursor from its previous life")
        cases.append("cold_projection_resets_previous_epoch_cursor")

        var unreadable = firstJob; unreadable["events"] = []
        input["key"] = UUID().uuidString; input["method"] = "snapshot"; input["jobs"] = [unreadable]
        do { _ = try project(projection, input); throw failure("Completed task without Pi records returned a fabricated transcript") }
        catch let error as GuguHostFailure { if error.code != "record_unreadable" { throw error } }
        cases.append("missing_completed_record_fails_without_summary_fallback")
        let raw: [String: Any] = ["firstJob": firstJob, "secondJob": secondJob, "snapshot": snapshot, "after": after, "twoTurns": twoTurns, "cold": cold]
        try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
        let result: [String: Any] = ["kind": "macos_real_pi_events_shared_timeline_with_fixtures_only", "result": "pass", "cases": cases,
            "diagnostics": try projection.diagnostics(), "piDiagnostics": try host.diagnostics(), "fixtureModelCalls": model.calls, "fixtureToolCalls": tool.calls,
            "realModelCalls": 0, "realEventKitCalls": 0, "iosAppRuns": 0]
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    }
    static func project(_ runtime: GuguJavaScriptRuntime, _ input: [String: Any]) throws -> [String: Any] {
        let done = DispatchSemaphore(value: 0); var reply: [String: Any] = [:]
        try runtime.readTimeline(input) { reply = $0; done.signal() }; try wait(done)
        guard reply["ok"] as? Bool == true, let data = reply["data"] as? [String: Any] else {
            throw GuguHostFailure(code: reply["code"] as? String ?? "projection_failed", message: reply["message"] as? String ?? "Timeline failed")
        }
        return data
    }
    static func contains(_ value: Any, key: String, value expected: String) -> Bool {
        if let object = value as? [String: Any] { return object[key] as? String == expected || object.values.contains { contains($0, key: key, value: expected) } }
        if let array = value as? [Any] { return array.contains { contains($0, key: key, value: expected) } }
        return false
    }
    static func wait(_ done: DispatchSemaphore) throws { if done.wait(timeout: .now() + 20) != .success { throw failure("Native timeline callback timed out") } }
    static func require(_ condition: Bool, _ message: String) throws { if !condition { throw failure(message) } }
    static func failure(_ message: String) -> GuguHostFailure { GuguHostFailure(code: "timeline_regression", message: message) }
}
