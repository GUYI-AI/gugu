import Foundation

private final class Secrets: GuguIOSClosureSecrets {
    var values: [String: Data] = [:]
    var failNextWrite = false
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ key: String, data: Data) throws {
        if failNextWrite { failNextWrite = false; throw GuguIOSAccountClosure.failure("injected_checkpoint_failure") }
        values[key] = data
    }
}
private func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !value() { throw GuguIOSAccountClosure.failure(message) }
}
private func reject(_ code: String, _ body: () throws -> Void) throws {
    do { try body(); throw GuguIOSAccountClosure.failure("expected_rejection") }
    catch let error as GuguHostFailure { try require(error.code == code, "unexpected_rejection_code") }
}
@main struct AccountClosureTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let ownerA = UUID().uuidString.lowercased(), ownerB = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        let a = GuguIOSClosureScope(ownerId: ownerA, localOperationId: "local-operation-A")
        let b = GuguIOSClosureScope(ownerId: ownerB, localOperationId: UUID().uuidString.lowercased())
        let secrets = Secrets(), files = GuguIOSClosureFiles(root: root)
        var current: String? = ownerA, pending = true, inject = false, main: [String: String] = [ownerA: "A", ownerB: "B"]
        for directory in GuguIOSClosureFiles.directories {
            for owner in [ownerA, ownerB] {
                let url = root.appendingPathComponent(directory).appendingPathComponent(owner)
                try fm.createDirectory(at: url, withIntermediateDirectories: true)
                try Data((owner == ownerA ? "A private state" : "B unchanged state").utf8).write(to: url.appendingPathComponent("fixture"))
            }
        }
        var operations: [(GuguIOSClosureScope) throws -> Bool] = [
            { scope in main.removeValue(forKey: scope.ownerId); return true },
        ]
        operations += GuguIOSClosureFiles.directories.map { directory in { scope in
            try files.erase(ownerId: scope.ownerId, directory: directory)
            if inject { inject = false; secrets.failNextWrite = true }
            return true
        } }
        func open() -> GuguIOSAccountClosure {
            GuguIOSAccountClosure(secrets: secrets, installation: { install }, localAuthBarrier: { body in try body() },
                mainOwner: { current }, preparation: { _ in !pending }, steps: operations, retained: { ["files-staging", "auth-oauth-pending"] })
        }
        let engine = open()
        try reject("closure_context_missing") { _ = try engine.get(a) }
        try reject("closure_context_missing") { _ = try engine.eraseLocal(a) }
        try reject("closure_context_missing") { try engine.remove(a) }
        try reject("wrong_local_owner") { try engine.put(b, receipt: "opaque-B") }
        try engine.put(a, receipt: "opaque-A"); try engine.put(a, receipt: "opaque-A")
        current = ownerB; try engine.put(b, receipt: "opaque-B")
        let bBefore = secrets.values
        let bRows = bBefore.filter { String(decoding: $0.value, as: UTF8.self).contains("opaque-B") }
        try require(bRows.count == 1, "B_fixture_not_unique")
        try require(try engine.eraseLocal(a).status == "pending", "mixed_cleanup_not_pending")
        try require(try engine.get(a) == "opaque-A", "pending_receipt_was_removed")
        try require(secrets.values == bBefore, "pending_mutated_secure_data")
        pending = false; inject = true
        try reject("injected_checkpoint_failure") { _ = try engine.eraseLocal(a) }
        let reopened = open(), result = try reopened.eraseLocal(a)
        try require(result.status == "complete" && result.retainedUnattributed.count == 2, "resume_did_not_complete")
        try require(try reopened.eraseLocal(a).status == "complete", "duplicate_erase_failed")
        for directory in GuguIOSClosureFiles.directories {
            try require(!fm.fileExists(atPath: root.appendingPathComponent(directory).appendingPathComponent(ownerA).path), "A_directory_survived")
            let bytes = try Data(contentsOf: root.appendingPathComponent(directory).appendingPathComponent(ownerB).appendingPathComponent("fixture"))
            try require(bytes == Data("B unchanged state".utf8), "B_directory_changed")
        }
        try require(main == [ownerB: "B"], "B_main_state_changed")
        try require(try reopened.get(b) == "opaque-B", "B_receipt_changed")
        try require(bRows.allSatisfy { secrets.values[$0.key] == $0.value }, "B_secure_bytes_changed")
        try reopened.remove(a); try reopened.remove(a)
        try require(try reopened.get(a) == nil && reopened.eraseLocal(a).status == "complete", "terminal_remove_not_idempotent")
        let c = GuguIOSClosureScope(ownerId: ownerB, localOperationId: UUID().uuidString.lowercased())
        try reopened.put(c, receipt: "unknown-result"); try reopened.remove(c)
        try reject("receipt_missing") { _ = try reopened.eraseLocal(c) }
        let hostile = root.appendingPathComponent("host").appendingPathComponent(ownerA)
        let outside = root.appendingPathComponent("outside"); try fm.createDirectory(at: outside, withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: hostile, withDestinationURL: outside)
        try reject("closure_path_changed") { try files.erase(ownerId: ownerA, directory: "host") }
        let retirementRoot = root.appendingPathComponent("mixed-retirement")
        let retirement = GuguIOSOwnerRetirementStore(directory: retirementRoot)
        let ba = GuguIOSHostBinding(ownerId: ownerA, deviceId: "phone-" + install + "-" + ownerA, installationId: install)
        let bb = GuguIOSHostBinding(ownerId: ownerB, deviceId: "phone-" + install + "-" + ownerB, installationId: install)
        let targetB = try GuguIOSOwnerRetirementStore.Target(ownerId: ownerB, accessToken: "synthetic-B")
        let intent = try retirement.begin(target: targetB)
        _ = try retirement.capture(id: intent.id, original: .init(binding: ba, sessionId: UUID().uuidString.lowercased(), accessSHA256: GuguIOSOwnerRetirementStore.digest("synthetic-A")))
        try retirement.markCleanupComplete(id: intent.id)
        let originalMixedBytes = try Data(contentsOf: retirementRoot.appendingPathComponent("owner-retirement.json"))
        try require(try retirement.prepareLocalErase(ownerId: ownerA) == false, "mixed_record_must_wait")
        try require(try Data(contentsOf: retirementRoot.appendingPathComponent("owner-retirement.json")) == originalMixedBytes, "mixed_B_record_changed")
        try retirement.commit(id: intent.id, target: targetB) { .init(ownerId: ownerB, accessToken: "synthetic-B", expiresAt: Date().addingTimeInterval(60)) }
        try require(try retirement.prepareLocalErase(ownerId: ownerA), "finished_mixed_record_did_not_unblock")
        let lifeRoot = root.appendingPathComponent("late-callbacks")
        var identity = ba
        let life = GuguIOSHostLifecycle(root: lifeRoot, verifiedIdentity: { identity })
        try life.activate(binding: ba)
        let oldAJournal = try life.journal(binding: ba)
        try reject("closure_not_prepared") { try life.sealForLocalAccountErase(ownerId: ownerA) }
        try life.stop(ownerId: ownerA)
        try life.sealForLocalAccountErase(ownerId: ownerA)
        try reject("stale_context") { _ = try life.journal(binding: ba) }
        try fm.removeItem(at: lifeRoot.appendingPathComponent(ownerA))
        do { try oldAJournal.cancelAllTasks(); throw GuguIOSAccountClosure.failure("late_journal_write_was_accepted") }
        catch let error as GuguHostFailure where error.code == "late_journal_write_was_accepted" { throw error }
        catch { }
        try require(!fm.fileExists(atPath: lifeRoot.appendingPathComponent(ownerA).path), "late_callback_recreated_A_directory")
        identity = bb; try life.activate(binding: bb)
        let bJournalPath = lifeRoot.appendingPathComponent(ownerB).appendingPathComponent("host.json")
        let bJournalBytes = try Data(contentsOf: bJournalPath)
        try life.sealForLocalAccountErase(ownerId: ownerA)
        try require(try Data(contentsOf: bJournalPath) == bJournalBytes, "B_runtime_journal_changed")
        try life.stop(ownerId: ownerB)
        print("{\"result\":\"pass\",\"cases\":[\"missing_put\",\"local_owner_only\",\"A_B_isolation\",\"pending_preserves_receipt\",\"checkpoint_interruption_and_fresh_resume\",\"repeated_erase_remove\",\"no_receipt_no_erase\",\"symlink_rejected\",\"mixed_retirement_B_bytes_unchanged_then_unblocked\",\"late_A_context_rejected_B_runtime_unchanged\"],\"realHTTP\":0,\"realModels\":0}")
    }
}
