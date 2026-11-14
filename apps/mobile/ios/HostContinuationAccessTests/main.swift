import Foundation
import CryptoKit

private final class AccessFixture: GuguNativeToolExecutor {
    var granted = true
    var revokeAfterSourceRead = false
    var continuationChecks = 0
    func validateAccess(_ control: GuguNativeToolControl) throws {
        try control.checkActive()
        if revokeAfterSourceRead {
            continuationChecks += 1
            if continuationChecks > 1 { granted = false }
        }
        if !granted { throw GuguHostFailure(code: "os_permission", message: "Injected OS revocation") }
    }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        completion(["ok": true, "data": ["events": [["title": "PRIVATE-CALENDAR-FIXTURE"]], "timezone": "UTC"]])
    }
}
private final class ContinuationModel: GuguModelCompleting {
    var calls = 0
    var continuing = false
    var copiedCalendarReachedModel = false
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        if continuing, let bytes = try? JSONSerialization.data(withJSONObject: body), String(decoding: bytes, as: UTF8.self).contains("PRIVATE-CALENDAR-FIXTURE") { copiedCalendarReachedModel = true }
        let tool = !continuing && calls == 1
        let message: [String: Any] = tool
            ? ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "calendar-fixture", "type": "function", "function": ["name": "phone_calendar_list", "arguments": "{\"date\":\"2026-11-08\"}"]]]]
            : ["role": "assistant", "content": "Fixture final text"]
        completion(["ok": true, "data": ["choices": [["finish_reason": tool ? "tool_calls" : "stop", "message": message]]]])
    }
    func cancel(id: String) {}
}
@main struct ContinuationAccessTests {
    static func main() throws {
        let asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let hash = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        let base = URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent(UUID().uuidString)
        var results: [[String: Any]] = []
        for mode in ["revoked_between_copy_and_model", "revoked_after_continuation_completed"] {
            let owner = UUID().uuidString, install = UUID().uuidString
            let journal = try GuguHostJournal(root: base.appendingPathComponent(mode), ownerId: owner, installationId: install)
            let done = DispatchSemaphore(value: 0), executor = AccessFixture(), model = ContinuationModel()
            let host = try GuguInProcessHost(asset: asset, expectedSHA256: hash, journal: journal, executor: executor, model: model,
                currentIdentity: { (owner, install) }, event: { if $0["type"] as? String == "task_status" { done.signal() } })
            let source = GuguHostContext(ownerId: owner, installationId: install, agentUserId: UUID().uuidString,
                sessionId: UUID().uuidString, jobId: UUID().uuidString, contextEpoch: UUID().uuidString, runtimeInstanceId: host.runtimeInstanceId)
            _ = try host.start(context: source, prompt: "Read fixture calendar", modelId: "fixture", systemPrompt: "fixture", tools: [["name": "phone_calendar_list", "actionName": "calendar.events.list"]])
            guard done.wait(timeout: .now() + 10) == .success else { throw GuguHostFailure(code: "test_timeout", message: "Source fixture did not finish") }
            let before = model.calls
            model.continuing = true
            executor.revokeAfterSourceRead = mode == "revoked_between_copy_and_model"
            let next = GuguHostContext(ownerId: owner, installationId: install, agentUserId: source.agentUserId,
                sessionId: source.sessionId, jobId: UUID().uuidString, contextEpoch: source.contextEpoch, runtimeInstanceId: host.runtimeInstanceId)
            _ = try host.continueTask(previousJobId: source.jobId, context: next, prompt: "Continue without another tool call", modelId: "fixture", systemPrompt: "fixture", tools: [])
            guard done.wait(timeout: .now() + 10) == .success else { throw GuguHostFailure(code: "test_timeout", message: "Continuation fixture did not finish") }
            executor.granted = false
            var historyDenied = false
            do { _ = try host.readTask(jobId: next.jobId) }
            catch let error as GuguHostFailure { historyDenied = ["os_permission", "not_granted"].contains(error.code) }
            let job = try journal.job(next.jobId)
            let preventedModel = mode != "revoked_between_copy_and_model" || model.calls == before
            let pass = job["usedCalendar"] as? Bool == true && historyDenied && preventedModel
            results.append(["case": mode, "pass": pass, "continuedJobProtected": job["usedCalendar"] as? Bool ?? false,
                "historyDeniedAfterRevocation": historyDenied, "continuationFixtureModelCalls": model.calls - before,
                "copiedCalendarReachedFixtureModel": model.copiedCalendarReachedModel, "continuationValidationChecks": executor.continuationChecks,
                "dataRoot": base.path])
            try host.stop()
        }
        print(String(data: try JSONSerialization.data(withJSONObject: ["kind": "B_author_actual_Pi_JSC_continuation_access_fixture_only", "results": results,
            "pid": ProcessInfo.processInfo.processIdentifier, "realModelCalls": 0, "realEventKitCalls": 0], options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
        if results.contains(where: { $0["pass"] as? Bool != true }) { exit(1) }
    }
}
