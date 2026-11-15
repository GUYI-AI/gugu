import Foundation
import CryptoKit

// Actual packaged Pi/JSC and APFS journal; model/OS responses are explicit fixtures.
private func uuid() -> String { UUID().uuidString.lowercased() }
private func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw GuguHostFailure(code: "test_failed", message: message) }
}
private func reject(_ code: String, _ work: () throws -> Void) throws {
    do { try work(); throw GuguHostFailure(code: "test_failed", message: "Expected \(code)") }
    catch let error as GuguHostFailure { try check(error.code == code, "Expected \(code), got \(error.code)") }
}
private final class CalendarFixture: GuguNativeToolExecutor {
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        completion(["ok": true, "data": ["events": [], "timezone": "UTC", "fixture": true]])
    }
}
private final class HeldModel: GuguModelCompleting {
    private let lock = NSLock()
    private var ids: Set<String> = []
    private var cancelled: Set<String> = []
    let started = DispatchSemaphore(value: 0)
    let stopped = DispatchSemaphore(value: 0)
    var onStart: (() -> Void)?
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        lock.lock(); ids.insert(id); lock.unlock(); onStart?(); started.signal()
    }
    func cancel(id: String) {
        lock.lock(); let known = ids.contains(id); let first = cancelled.insert(id).inserted; lock.unlock()
        if known && first { stopped.signal() }
    }
    var cancelCount: Int { lock.lock(); defer { lock.unlock() }; return cancelled.count }
}
private func wait(_ value: DispatchSemaphore) throws {
    try check(value.wait(timeout: .now() + 10) == .success, "Timed out waiting for actual JSC cancellation")
}

@main struct LifecycleTests {
    static func main() throws {
        let base = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true).appendingPathComponent(uuid())
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let hash = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        let owner = uuid(), install = uuid()
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        var current: GuguIOSHostBinding? = binding
        let root = base.appendingPathComponent("main")
        let identity = { () throws -> GuguIOSHostBinding in
            guard let current else { throw GuguHostFailure(code: "stale_context", message: "Fixture publication sealed") }; return current
        }
        let lifecycle = GuguIOSHostLifecycle(root: root, verifiedIdentity: identity)
        let journal = try lifecycle.journal(binding: binding)
        func context(_ runtime: String) -> GuguHostContext {
            GuguHostContext(ownerId: owner, installationId: install, agentUserId: uuid(), sessionId: uuid(), jobId: uuid(), contextEpoch: uuid(), runtimeInstanceId: runtime)
        }
        let original = context(uuid())
        _ = try journal.admit(original, prompt: "journal-only fixture", modelId: "fixture")
        let secondFacade = GuguIOSHostLifecycle(root: root.appendingPathComponent("."), verifiedIdentity: identity)
        try check(journal === secondFacade.journal(binding: binding), "Same root reopened a live journal")
        try check(journal.job(original.jobId)["status"] as? String == "running", "Status read interrupted a live task")
        var passed = ["same_root_facades_share_journal_without_recovery"]

        // Cold disk journal, no runtime factory: calendar closure must still revoke.
        let coldRoot = base.appendingPathComponent("cold")
        let coldJournal = try GuguHostJournal(root: coldRoot, ownerId: owner, installationId: install)
        let cold = context(uuid()); _ = try coldJournal.admit(cold, prompt: "cold fixture", modelId: "fixture")
        _ = try coldJournal.admitTool(cold, toolCallId: "cold-calendar", action: "calendar.events.list", arguments: [:], deadlineAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60000)
        let coldLifecycle = GuguIOSHostLifecycle(root: coldRoot, verifiedIdentity: identity)
        try coldLifecycle.revokeCalendarAccess(binding: binding)
        try check(coldJournal.job(cold.jobId)["contextInvalidated"] as? Bool == true, "No-host calendar revoke did not persist")
        passed.append("cold_calendar_revoke_without_runtime")

        let executor = CalendarFixture()
        func make(_ lifecycle: GuguIOSHostLifecycle, _ model: HeldModel, _ key: String) throws -> GuguInProcessHost {
            try lifecycle.host(binding: binding, nativeKey: key) { shared in
                try GuguInProcessHost(asset: asset, expectedSHA256: hash, journal: shared, executor: executor, model: model,
                    currentIdentity: { (current?.ownerId ?? "", current?.installationId ?? "") }, event: { _ in })
            }
        }
        let model1 = HeldModel(), model2 = HeldModel()
        let key1 = uuid(), host1 = try make(lifecycle, model1, key1), host2 = try make(lifecycle, model2, uuid())
        try check(host1 === make(secondFacade, model1, key1), "Native host key did not reuse runtime")
        let c1 = context(host1.runtimeInstanceId), c2 = context(host2.runtimeInstanceId)
        _ = try host1.start(context: c1, prompt: "fixture held 1", modelId: "fixture", systemPrompt: "fixture", tools: [])
        _ = try host2.start(context: c2, prompt: "fixture held 2", modelId: "fixture", systemPrompt: "fixture", tools: [])
        try wait(model1.started); try wait(model2.started)
        for c in [c1, c2] { _ = try journal.admitTool(c, toolCallId: "protected", action: "calendar.events.list", arguments: [:], deadlineAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60000) }
        try secondFacade.revokeCalendarAccess(binding: binding)
        try wait(model1.stopped); try wait(model2.stopped)
        try check(journal.job(c1.jobId)["contextInvalidated"] as? Bool == true && journal.job(c2.jobId)["contextInvalidated"] as? Bool == true, "Shared revoke missed a runtime")
        passed.append("one_durable_revoke_cancels_all_real_runtimes")

        let otherOwner = uuid()
        let otherBinding = GuguIOSHostBinding(ownerId: otherOwner, deviceId: "phone-\(install)-\(otherOwner)", installationId: install)
        let otherLifecycle = GuguIOSHostLifecycle(root: root, verifiedIdentity: { otherBinding })
        let otherJournal = try otherLifecycle.journal(binding: otherBinding)
        let otherContext = GuguHostContext(ownerId: otherOwner, installationId: install, agentUserId: uuid(), sessionId: uuid(), jobId: uuid(), contextEpoch: uuid(), runtimeInstanceId: uuid())
        _ = try otherJournal.admit(otherContext, prompt: "other owner fixture", modelId: "fixture")
        // Stop after publication is sealed; no current credentials are needed.
        current = nil
        try lifecycle.stop(ownerId: owner)
        try check(otherJournal.job(otherContext.jobId)["status"] as? String == "running", "Owner-scoped stop affected another owner")
        try lifecycle.stopAll()
        try check(otherJournal.job(otherContext.jobId)["status"] as? String == "cancelled", "Zero-argument stop missed another registered owner")
        passed.append("owner_scoped_stop_and_zero_argument_all_owner_barrier")
        try reject("stale_context") { _ = try lifecycle.journal(binding: binding) }
        current = binding
        try reject("host_stopping") { _ = try make(lifecycle, HeldModel(), uuid()) }
        try lifecycle.activate(binding: binding)
        try check(journal === lifecycle.journal(binding: binding), "Reactivate reopened the journal")
        try reject("stale_context") { _ = try host1.start(context: context(host1.runtimeInstanceId), prompt: "old runtime", modelId: "fixture", systemPrompt: "fixture", tools: []) }
        passed.append("sealed_publication_stop_and_explicit_reactivation")

        let model3 = HeldModel(), model4 = HeldModel()
        let host3 = try make(lifecycle, model3, uuid()), host4 = try make(lifecycle, model4, uuid())
        let c3 = context(host3.runtimeInstanceId), c4 = context(host4.runtimeInstanceId)
        _ = try host3.start(context: c3, prompt: "disk failure 1", modelId: "fixture", systemPrompt: "fixture", tools: [])
        _ = try host4.start(context: c4, prompt: "disk failure 2", modelId: "fixture", systemPrompt: "fixture", tools: [])
        try wait(model3.started); try wait(model4.started)
        let file = root.appendingPathComponent(owner).appendingPathComponent("host.json")
        let backup = file.appendingPathExtension("saved")
        try FileManager.default.moveItem(at: file, to: backup)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        var stopFailed = false
        do { try lifecycle.stop(ownerId: owner) } catch { stopFailed = true }
        try check(stopFailed, "Disk failure was reported as successful retirement")
        try wait(model3.stopped); try wait(model4.stopped)
        try reject("host_stopping") { try lifecycle.activate(binding: binding) }
        try FileManager.default.removeItem(at: file); try FileManager.default.moveItem(at: backup, to: file)
        try lifecycle.stop(ownerId: owner)
        try check(journal.job(c3.jobId)["status"] as? String == "cancelled" && journal.job(c4.jobId)["status"] as? String == "cancelled", "Retry did not finish disk retirement")
        passed.append("disk_failure_still_cancels_all_transports_and_retries")

        // No runtime: stop disk custody, preserve a claimed write, accept its late receipt.
        let writeRoot = base.appendingPathComponent("write")
        let writeLifecycle = GuguIOSHostLifecycle(root: writeRoot, verifiedIdentity: identity)
        let writeJournal = try writeLifecycle.journal(binding: binding)
        let writeContext = context(uuid()); _ = try writeJournal.admit(writeContext, prompt: "write fixture", modelId: "fixture")
        let (write, _) = try writeJournal.admitTool(writeContext, toolCallId: "write", action: "calendar.events.create", arguments: ["title": "fixture"], deadlineAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60000)
        try writeJournal.approve(write); try writeJournal.beginMutation(write)
        try writeLifecycle.stop(ownerId: owner)
        try check(writeJournal.calls(jobId: writeContext.jobId).first?["status"] as? String == "execution_unknown", "Stop guessed the result of a claimed write")
        try writeJournal.finishMutation(write, result: ["event_id": "known-late-fixture"])
        try check(writeJournal.calls(jobId: writeContext.jobId).first?["receipt"] != nil, "Retirement dropped a known late receipt")
        passed.append("journal_only_stop_preserves_unknown_and_known_late_receipt")

        let reentrant = GuguIOSHostLifecycle(root: base.appendingPathComponent("reentrant"), verifiedIdentity: identity)
        let reentrantModel = HeldModel()
        let reentrantHost = try make(reentrant, reentrantModel, uuid())
        var reentrantError: Error?
        reentrantModel.onStart = { do { try reentrant.stopAll() } catch { reentrantError = error } }
        let reentrantContext = context(reentrantHost.runtimeInstanceId)
        _ = try reentrantHost.start(context: reentrantContext, prompt: "stop on JSC queue", modelId: "fixture", systemPrompt: "fixture", tools: [])
        try wait(reentrantModel.started); try wait(reentrantModel.stopped)
        try check(reentrantError == nil, "Same-JSC-queue retirement failed")
        passed.append("same_JSC_queue_stop_does_not_dispatch_sync_to_itself")
        print(String(data: try JSONSerialization.data(withJSONObject: ["kind": "B_author_lifecycle_actual_JSC_private_disk_with_fixture_model", "pid": ProcessInfo.processInfo.processIdentifier, "passed": passed, "cases": passed.count, "realModelCalls": 0, "realEventKitCalls": 0, "iOSAppRuns": 0, "dataRoot": base.path], options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    }
}
