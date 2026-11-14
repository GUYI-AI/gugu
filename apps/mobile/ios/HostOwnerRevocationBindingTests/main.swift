import Foundation

/// Actual disk/lifecycle custody with an injected switch at the revocation
/// callback boundary. This does not exercise login, EventKit or an iOS App.
@main struct HostOwnerRevocationBindingTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        var cases: [String] = []
        for sameOwner in [false, true] {
            let base = root.appendingPathComponent(UUID().uuidString)
            let old = binding(), next = binding(ownerId: sameOwner ? old.ownerId : nil)
            var current = old
            let lifecycle = GuguIOSHostLifecycle(root: base.appendingPathComponent("host"), verifiedIdentity: { current })
            let oldJournal = try lifecycle.journal(binding: old)
            let oldContext = context(old)
            try admitCalendar(oldJournal, oldContext)
            var switchAtCallback = false, received: GuguIOSHostBinding?, nextJournal: GuguHostJournal?, nextContext: GuguHostContext?
            let access = GuguIOSOwnerAccess(root: base.appendingPathComponent("category"), verifiedIdentity: { current },
                requireOwnerUI: {}, calendarHasFullAccess: { true }, revokeCalendarAccess: { expected in
                    received = expected
                    if switchAtCallback {
                        current = next
                        let nextLifecycle = GuguIOSHostLifecycle(root: base.appendingPathComponent(sameOwner ? "replacement-host" : "host"), verifiedIdentity: { current })
                        let journal = try nextLifecycle.journal(binding: next), admitted = context(next)
                        try admitCalendar(journal, admitted)
                        nextJournal = journal; nextContext = admitted
                    }
                    try lifecycle.revokeCalendarAccess(binding: expected)
                })
            let attempt = try access.beginCalendarConnection(expectedBinding: old)
            _ = try access.finishCalendarConnection(attempt: attempt)
            try require(received == old, "Current-owner callback did not receive original binding")
            // A normal revocation reached the journal and retired its calendar epoch.
            try require(try oldJournal.job(oldContext.jobId)["contextInvalidated"] as? Bool == true, "Same-binding revocation did not reach journal")
            switchAtCallback = true
            try stale { _ = try access.disconnectCalendar(expectedBinding: old) }
            try require(received == old, "Old transaction selected the new account binding")
            guard let journal = nextJournal, let admitted = nextContext else { throw failure("No newly admitted context") }
            let saved = try journal.job(admitted.jobId)
            try require(saved["status"] as? String == "running" && saved["contextInvalidated"] as? Bool != true,
                "Stale revocation mutated the new account or installation")
            try stale { try lifecycle.revokeCalendarAccess(binding: old) }
            try require(try journal.job(admitted.jobId)["status"] as? String == "running", "Lifecycle accepted stale binding")
            cases.append(sameOwner ? "installation_switch_preserves_new_calendar_task" : "account_switch_preserves_new_calendar_task")
        }
        let result: [String: Any] = ["kind": "macos_owner_revocation_binding_with_injected_identity_only", "result": "pass", "cases": cases,
            "realModelCalls": 0, "realEventKitCalls": 0, "verifiedLoginRuns": 0, "iosAppRuns": 0]
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    }
    static func binding(ownerId: String? = nil) -> GuguIOSHostBinding {
        let owner = ownerId ?? UUID().uuidString.lowercased(), installation = UUID().uuidString.lowercased()
        return GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
    }
    static func context(_ binding: GuguIOSHostBinding) -> GuguHostContext {
        GuguHostContext(ownerId: binding.ownerId, installationId: binding.installationId, agentUserId: UUID().uuidString,
            sessionId: UUID().uuidString, jobId: UUID().uuidString, contextEpoch: UUID().uuidString, runtimeInstanceId: UUID().uuidString)
    }
    static func admitCalendar(_ journal: GuguHostJournal, _ context: GuguHostContext) throws {
        _ = try journal.admit(context, prompt: "binding fixture", modelId: "fixture")
        _ = try journal.admitTool(context, toolCallId: "calendar", action: "calendar.events.list", arguments: [:], deadlineAtMs: 4102444800000)
    }
    static func stale(_ action: () throws -> Void) throws {
        do { try action(); throw failure("Expected stale_context") }
        catch let error as GuguHostFailure { if error.code != "stale_context" { throw error } }
    }
    static func require(_ condition: Bool, _ message: String) throws { if !condition { throw failure(message) } }
    static func failure(_ message: String) -> GuguHostFailure { GuguHostFailure(code: "revocation_binding_regression", message: message) }
}
