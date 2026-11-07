import Foundation

@main struct HostJournalRotationTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        var results: [[String: Any]] = []
        for scenario in ["late_receipt_preserves_replacement", "replacement_write_preserves_late_receipt", "latest_reads_and_single_claim"] {
            let directory = root.appendingPathComponent(scenario)
            do {
                try run(scenario, root: directory)
                results.append(["name": scenario, "result": "pass"])
            } catch {
                results.append(["name": scenario, "result": "fail", "error": String(describing: error)])
            }
        }
        let failed = results.contains { $0["result"] as? String == "fail" }
        let report: [String: Any] = ["kind": "macos_native_journal_rotation_only", "pid": ProcessInfo.processInfo.processIdentifier,
            "cases": results, "realModelCalls": 0, "realEventKitCalls": 0, "result": failed ? "fail" : "pass"]
        print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
        if failed { exit(1) }
    }

    static func run(_ scenario: String, root: URL) throws {
        let owner = UUID().uuidString, install = UUID().uuidString
        let oldContext = context(owner, install)
        let old = try GuguHostJournal(root: root, ownerId: owner, installationId: install)
        _ = try old.admit(oldContext, prompt: "old", modelId: "no-network")
        let (write, _) = try old.admitTool(oldContext, toolCallId: "write", action: "calendar.events.create",
            arguments: ["title": "rotation fixture"], deadlineAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60000)
        try old.approve(write)
        try old.beginMutation(write)
        let replacement = try GuguHostJournal(root: root, ownerId: owner, installationId: install)
        let next = context(owner, install)
        _ = try replacement.admit(next, prompt: "replacement", modelId: "no-network")

        if scenario == "latest_reads_and_single_claim" {
            try require(try old.job(next.jobId)["status"] as? String == "running", "Old handle cannot read new job")
            try require(try old.calls(jobId: oldContext.jobId).first?["status"] as? String == "execution_unknown", "Old handle reads stale claim")
            do { try old.checkActive(oldContext); throw failure("Old task remained active") }
            catch let error as GuguHostFailure { if error.code != "cancelled" { throw error } }
            let (fresh, _) = try replacement.admitTool(next, toolCallId: "fresh", action: "calendar.events.create",
                arguments: ["title": "fresh"], deadlineAtMs: write.deadlineAtMs)
            try old.approve(fresh)
            try replacement.beginMutation(fresh)
            do { try old.beginMutation(fresh); throw failure("Cross-handle approval consumed twice") }
            catch let error as GuguHostFailure { if error.code != "not_granted" { throw error } }
        } else {
            try old.finishMutation(write, result: ["event_id": "known-late-result"])
            var disk = try snapshot(root, owner)
            try require((disk["jobs"] as? [String: Any])?[next.jobId] != nil, "Late receipt deleted replacement job")
            try require(try replacement.calls(jobId: oldContext.jobId).first?["status"] as? String == "completed", "Replacement did not read late receipt")
            if scenario == "replacement_write_preserves_late_receipt" {
                try replacement.record(next, event: ["type": "rotation_followup"], messages: nil)
                disk = try snapshot(root, owner)
            }
            let saved = (disk["calls"] as? [String: [String: Any]])?[write.requestId]
            let receipt = saved?["receipt"] as? [String: Any]
            try require((receipt?["data"] as? [String: Any])?["event_id"] as? String == "known-late-result", "New write erased late receipt")
            try require(try old.job(oldContext.jobId)["status"] as? String == "interrupted", "Late receipt revived interrupted task")
        }
        let disk = try snapshot(root, owner)
        try JSONSerialization.data(withJSONObject: disk, options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("verified-disk.json"))
    }

    static func context(_ owner: String, _ install: String) -> GuguHostContext {
        GuguHostContext(ownerId: owner, installationId: install, agentUserId: UUID().uuidString, sessionId: UUID().uuidString,
            jobId: UUID().uuidString, contextEpoch: UUID().uuidString, runtimeInstanceId: UUID().uuidString)
    }
    static func snapshot(_ root: URL, _ owner: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent(owner).appendingPathComponent("host.json"))) as! [String: Any]
    }
    static func require(_ value: Bool, _ message: String) throws { if !value { throw failure(message) } }
    static func failure(_ message: String) -> GuguHostFailure { GuguHostFailure(code: "rotation_regression", message: message) }
}
