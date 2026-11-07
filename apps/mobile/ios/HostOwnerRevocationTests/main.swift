import Foundation

@main struct HostOwnerRevocationTests {
    static func main() throws {
        if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--reopen" { try reopen(); return }
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        var results: [[String: Any]] = []
        for target in ["journal", "category", "refusal"] {
            do { try run(root.appendingPathComponent(target), target: target); results.append(["name": target + "_io_failure_then_regrant_across_handles", "result": "pass"]) }
            catch { results.append(["name": target + "_io_failure_then_regrant_across_handles", "result": "fail", "error": String(describing: error)]) }
        }
        let failed = results.contains { $0["result"] as? String == "fail" }
        print(String(data: try JSONSerialization.data(withJSONObject: ["kind": "macos_owner_revocation_real_disk_faults_injected_os", "cases": results,
            "result": failed ? "fail" : "pass", "realModelCalls": 0, "realEventKitCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
        if failed { exit(1) }
    }

    static func run(_ root: URL, target: String) throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        let journal = try GuguHostJournal(root: root, ownerId: owner, installationId: install)
        var full = true
        func access() -> GuguIOSOwnerAccess {
            GuguIOSOwnerAccess(root: root, verifiedIdentity: { binding }, requireOwnerUI: {}, calendarHasFullAccess: { full },
                revokeCalendarAccess: { _ in _ = try journal.invalidateCalendarContexts() })
        }
        let first = access()
        let attempt = try first.beginCalendarConnection(expectedBinding: binding)
        _ = try first.finishCalendarConnection(attempt: attempt)
        let context = GuguHostContext(ownerId: owner, installationId: install, agentUserId: UUID().uuidString,
            sessionId: UUID().uuidString, jobId: UUID().uuidString, contextEpoch: UUID().uuidString, runtimeInstanceId: UUID().uuidString)
        _ = try journal.admit(context, prompt: "revocation disk fixture", modelId: "no-network")
        _ = try journal.admitTool(context, toolCallId: "list", action: "calendar.events.list", arguments: ["start_ms": 0, "end_ms": 1], deadlineAtMs: Int64(Date().timeIntervalSince1970 * 1000) + 60000)
        let directory = root.appendingPathComponent(owner)
        let category = directory.appendingPathComponent("calendar-connection.json")
        let path = directory.appendingPathComponent(target == "journal" ? "host.json" : target == "category" ? "calendar-connection.json" : "calendar-revocation.pending.json")
        let backup = path.appendingPathExtension("original")
        if target != "refusal" { try FileManager.default.moveItem(at: path, to: backup) }
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: false)
        full = false
        try fails { _ = try first.ownerSnapshot(expectedBinding: binding) }
        let second = access()
        try fails { _ = try second.ownerSnapshot(expectedBinding: binding) }
        if target == "journal" {
            let pending = try object(category)
            try require(pending["connected"] as? Bool == false && pending["revocationPending"] as? Bool == true, "Revocation intent was not durable before failed journal write")
        }
        full = true
        try fails { _ = try second.ownerSnapshot(expectedBinding: binding) }
        try FileManager.default.removeItem(at: path)
        if target != "refusal" { try FileManager.default.moveItem(at: backup, to: path) }
        let input = root.appendingPathComponent("reopen-input.json")
        try JSONSerialization.data(withJSONObject: ["ownerId": owner, "installationId": install, "deviceId": binding.deviceId, "jobId": context.jobId]).write(to: input)
        let process = Process(); process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        process.arguments = ["--reopen", root.path, input.path]
        for name in ["worker-home", "worker-data", "worker-tmp"] { try FileManager.default.createDirectory(at: root.appendingPathComponent(name), withIntermediateDirectories: true) }
        process.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "GUGU_HOME": root.appendingPathComponent("worker-home").path,
            "GUGU_USER_DATA_DIR": root.appendingPathComponent("worker-data").path, "TMPDIR": root.appendingPathComponent("worker-tmp").path + "/"]
        let stdout = Pipe(), stderr = Pipe(); process.standardOutput = stdout; process.standardError = stderr
        try process.run()
        let result = stdout.fileHandleForReading.readDataToEndOfFile(), errors = stderr.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        try result.write(to: root.appendingPathComponent("worker.stdout.json")); try errors.write(to: root.appendingPathComponent("worker.stderr"))
        try require(process.terminationStatus == 0 && errors.isEmpty, "Fresh process could not complete durable revocation")
        let worker = try JSONSerialization.jsonObject(with: result) as! [String: Any]
        try require(worker["connected"] as? Bool == false && worker["oldInvalidated"] as? Bool == true, "Fresh process revived connected state or old epoch")
        // A third handle must repair the shared/durable denial before returning.
        let third = access()
        let repaired = try third.ownerSnapshot(expectedBinding: binding)
        try require(!repaired.calendarConnected, "OS regrant revived saved true after I/O failure")
        let old = try journal.job(context.jobId)
        try require(old["contextInvalidated"] as? Bool == true, "Old calendar epoch survived repaired revocation")
        try fails { try journal.checkActive(context) }
        try require(try !first.calendarEnabled(expectedBinding: binding), "Original handle revived its cached grant")
        let saved = try object(category)
        try require(saved["revocationPending"] as? Bool == false && saved["connected"] as? Bool == false, "Pending denial did not finish durably")
        try JSONSerialization.data(withJSONObject: ["category": saved, "oldJob": old], options: [.prettyPrinted, .sortedKeys]).write(to: root.appendingPathComponent("verified-repair.json"))
        let fresh = try third.beginCalendarConnection(expectedBinding: binding)
        _ = try third.finishCalendarConnection(attempt: fresh)
        try require(try third.calendarEnabled(expectedBinding: binding), "Fresh owner connection could not recover after completed revocation")
        try require(try journal.job(context.jobId)["contextInvalidated"] as? Bool == true, "Fresh consent revived the old context")
    }

    static func reopen() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[2])
        let saved = try object(URL(fileURLWithPath: CommandLine.arguments[3]))
        let binding = GuguIOSHostBinding(ownerId: saved["ownerId"] as! String, deviceId: saved["deviceId"] as! String, installationId: saved["installationId"] as! String)
        let journal = try GuguHostJournal(root: root, ownerId: binding.ownerId, installationId: binding.installationId)
        let access = GuguIOSOwnerAccess(root: root, verifiedIdentity: { binding }, requireOwnerUI: {}, calendarHasFullAccess: { true },
            revokeCalendarAccess: { _ in _ = try journal.invalidateCalendarContexts() })
        let snapshot = try access.ownerSnapshot(expectedBinding: binding)
        let job = try journal.job(saved["jobId"] as! String)
        print(String(data: try JSONSerialization.data(withJSONObject: ["connected": snapshot.calendarConnected,
            "oldInvalidated": job["contextInvalidated"] as? Bool ?? false, "pid": ProcessInfo.processInfo.processIdentifier], options: [.sortedKeys]), encoding: .utf8)!)
    }

    static func object(_ path: URL) throws -> [String: Any] { try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as! [String: Any] }
    static func fails(_ action: () throws -> Void) throws {
        var failed = false; do { try action() } catch { failed = true }
        try require(failed, "I/O fault returned an allowed snapshot")
    }
    static func require(_ value: Bool, _ message: String) throws { if !value { throw GuguHostFailure(code: "revocation_regression", message: message) } }
}
