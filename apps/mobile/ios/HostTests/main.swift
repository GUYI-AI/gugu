import Foundation
import CryptoKit

// This deliberately uses deterministic model/tool transport responses. It proves
// actual JSC/Pi/native callback behavior, never a real model or EventKit result.
@main struct HostBridgeSmoke {
    static func main() throws {
        let asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let hash = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        let done = DispatchSemaphore(value: 0)
        var modelCalls = 0
        var toolCalls = 0
        var journalEvents = 0
        var completed: [String: Any]?
        var hostErrors: [[String: Any]] = []
        let binding = GuguHostContext(ownerId: UUID().uuidString, installationId: UUID().uuidString,
            agentUserId: UUID().uuidString, sessionId: UUID().uuidString, jobId: UUID().uuidString,
            contextEpoch: UUID().uuidString, runtimeInstanceId: UUID().uuidString)
        let context = try JSONSerialization.jsonObject(with: JSONEncoder().encode(binding)) as! [String: Any]
        let runtime = try GuguJavaScriptRuntime(asset: asset, expectedSHA256: hash, request: { request, reply in
            switch request.method {
            case "model.complete":
                modelCalls += 1
                let message: [String: Any] = modelCalls == 1
                    ? ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "calendar-read-1", "type": "function", "function": ["name": "phone_calendar_list", "arguments": "{\"date\":\"2026-11-08\"}"]]]]
                    : ["role": "assistant", "content": "Deterministic bridge fixture completed"]
                reply(["ok": true, "data": ["choices": [["finish_reason": modelCalls == 1 ? "tool_calls" : "stop", "message": message]]]])
            case "tool.execute":
                toolCalls += 1
                precondition(request.payload["actionName"] as? String == "calendar.events.list")
                precondition((request.payload["args"] as? [String: Any])?["start_ms"] is NSNumber)
                reply(["ok": true, "data": ["ok": true, "data": ["events": [], "timezone": "Asia/Shanghai", "fixture": true]]])
            case "journal.event": journalEvents += 1; reply(["ok": true, "data": [:]])
            case "turn.finished": completed = request.payload; reply(["ok": true, "data": [:]]); done.signal()
            default: preconditionFailure("Unexpected native method")
            }
        }, cancel: { _ in }, event: { event in if event["type"] as? String == "host_error" { hostErrors.append(event); done.signal() } })
        let diagnostics = try runtime.diagnostics()
        precondition(diagnostics["node"] as? Bool == false)
        try runtime.start(["context": context, "modelId": "deterministic-fixture-only", "prompt": "Exercise the local calendar bridge", "systemPrompt": "Deterministic bridge validation", "tools": [["name": "phone_calendar_list", "actionName": "calendar.events.list", "description": "Read calendar through native bridge", "parameters": ["type": "object", "properties": ["date": ["type": "string"]]]]]])
        guard done.wait(timeout: .now() + 15) == .success else { throw GuguHostFailure(code: "test_timeout", message: "JSC/Pi did not complete") }
        precondition(hostErrors.isEmpty, "\(hostErrors)")
        precondition(completed?["status"] as? String == "done", "\(String(describing: completed))")
        precondition(modelCalls == 2 && toolCalls == 1 && journalEvents > 5, "model=\(modelCalls), tool=\(toolCalls), events=\(journalEvents), result=\(String(describing: completed))")
        print(try GuguJavaScriptRuntime.json(["result": "pass", "kind": "deterministic_bridge_only", "diagnostics": diagnostics, "modelTransportFixtures": modelCalls, "nativeToolFixtures": toolCalls, "realModelCalls": 0, "realEventKitCalls": 0, "journalEvents": journalEvents]))
    }
}
