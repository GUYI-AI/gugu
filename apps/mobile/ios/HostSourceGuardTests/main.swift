import Foundation
import CryptoKit

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "source_guard_test_failed", message: text) }
}
private final class Executor: GuguNativeToolExecutor {
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        completion(["ok": false, "code": "unexpected_tool", "message": "Source guard fixture has no tools"])
    }
}
private final class SourceGate {
    let lock = NSLock(), entered = DispatchSemaphore(value: 0)
    var allowed = true, hold = false
    var held: ((Result<Void, Error>) -> Void)?
    func authorize(_ context: GuguHostContext, _ done: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        if hold { held = done; lock.unlock(); entered.signal(); return }
        let accepted = allowed; lock.unlock()
        done(accepted ? .success(()) : .failure(GuguHostFailure(code: "not_granted", message: "Synthetic source membership revoked")))
    }
    func revoke() { lock.lock(); allowed = false; lock.unlock() }
    func release() { lock.lock(); let done = held; held = nil; lock.unlock(); done?(.success(())) }
}
private final class Model: GuguModelCompleting {
    let gate: SourceGate
    let revokeOnReply: Bool
    var calls = 0
    init(_ gate: SourceGate, revokeOnReply: Bool) { self.gate = gate; self.revokeOnReply = revokeOnReply }
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        calls += 1
        if revokeOnReply { gate.revoke() }
        completion(["ok": true, "data": ["choices": [["finish_reason": "stop", "message": ["role": "assistant", "content": "PRIVATE-SOURCE-GUARD-RESPONSE"]]]]])
    }
    func cancel(id: String) {}
}
@main struct HostSourceGuardTests {
    static func main() throws {
        let asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let hash = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        let root = URL(fileURLWithPath: CommandLine.arguments[1]); var cases: [String] = []
        for mode in ["allowed", "revoked_before_dispatch", "revoked_after_model_reply", "cancelled_while_authorizing"] {
            let owner = UUID().uuidString.lowercased(), installation = UUID().uuidString.lowercased(), gate = SourceGate()
            gate.allowed = mode != "revoked_before_dispatch"; gate.hold = mode == "cancelled_while_authorizing"
            let journal = try GuguHostJournal(root: root.appendingPathComponent(mode), ownerId: owner, installationId: installation)
            let model = Model(gate, revokeOnReply: mode == "revoked_after_model_reply"), done = DispatchSemaphore(value: 0)
            let host = try GuguInProcessHost(asset: asset, expectedSHA256: hash, journal: journal, executor: Executor(), model: model,
                currentIdentity: { (owner, installation) }, event: { if $0["type"] as? String == "task_status" { done.signal() } },
                sourceAuthorization: gate.authorize)
            let context = GuguHostContext(ownerId: owner, installationId: installation, agentUserId: UUID().uuidString.lowercased(),
                sessionId: UUID().uuidString.lowercased(), jobId: UUID().uuidString.lowercased(), contextEpoch: UUID().uuidString.lowercased(), runtimeInstanceId: host.runtimeInstanceId)
            _ = try host.start(context: context, prompt: "Synthetic source guard", modelId: "fixture", systemPrompt: "fixture", tools: [])
            if gate.hold {
                try require(gate.entered.wait(timeout: .now() + 10) == .success, "Native source authorization was not held")
                try host.cancel(context: context); gate.release()
            }
            try require(done.wait(timeout: .now() + 20) == .success, "Source-guard Pi task did not finish")
            let row = try journal.job(context.jobId)
            let saved = String(decoding: try JSONSerialization.data(withJSONObject: row), as: UTF8.self)
            switch mode {
            case "allowed": try require(model.calls == 1 && row["status"] as? String == "done" && saved.contains("PRIVATE-SOURCE-GUARD-RESPONSE"), "Allowed source positive control did not finish")
            case "revoked_after_model_reply": try require(model.calls == 1 && row["status"] as? String == "failed" && !saved.contains("PRIVATE-SOURCE-GUARD-RESPONSE"), "Late source revocation released model reply into Pi/journal")
            case "revoked_before_dispatch": try require(model.calls == 0 && row["status"] as? String == "failed", "Revoked source reached model transport")
            default: try require(model.calls == 0 && row["status"] as? String == "cancelled", "Cancelled task reached model after delayed source authorization")
            }
            cases.append(mode); try host.stop()
        }
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "actual_Pi_JSC_native_source_dispatch_guards_with_synthetic_model", "cases": cases,
            "realModelCalls": 0, "realCloudHTTPCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
