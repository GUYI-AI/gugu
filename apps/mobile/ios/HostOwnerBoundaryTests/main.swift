import Foundation

@main struct HostOwnerBoundaryTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let owner = UUID().uuidString.lowercased(), installation = UUID().uuidString.lowercased()
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
        var fullAccess = true, revocations = 0
        let access = GuguIOSOwnerAccess(root: root, verifiedIdentity: { binding }, requireOwnerUI: {}, calendarHasFullAccess: { fullAccess }, revokeCalendarAccess: { _ in revocations += 1 })
        let attempt = try access.beginCalendarConnection(expectedBinding: binding)
        _ = try access.finishCalendarConnection(attempt: attempt)
        let file = root.appendingPathComponent(owner).appendingPathComponent("calendar-connection.json")
        let before = try Data(contentsOf: file), count = revocations
        fullAccess = false
        try require(try access.ownerBinding() == binding, "Pure identity is unavailable during OS denial")
        try require(revocations == count && Data(contentsOf: file) == before, "Pure identity observed or mutated category")
        var cases = ["pure_identity_does_not_observe_os_revocation"]
        try stale { _ = try access.ownerSnapshot(expectedOwnerId: UUID().uuidString) }
        try require(revocations == count && Data(contentsOf: file) == before, "Old owner status mutated current revoked account")
        cases.append("old_owner_status_rejected_without_current_account_side_effects")
        let otherOwner = UUID().uuidString.lowercased()
        let old = GuguIOSHostBinding(ownerId: otherOwner, deviceId: "phone-\(installation)-\(otherOwner)", installationId: installation)
        try stale { _ = try access.ownerSnapshot(expectedBinding: old) }
        try stale { _ = try access.beginCalendarConnection(expectedBinding: old) }
        try stale { _ = try access.calendarEnabled(expectedBinding: old) }
        try require(revocations == count && Data(contentsOf: file) == before, "Old binding connect/tool mutated current revoked account")
        cases.append("old_binding_connect_and_tool_read_rejected_before_observation")
        let observed = try access.ownerSnapshot(expectedOwnerId: owner)
        try require(!observed.calendarConnected && revocations == count + 1, "Current owner observation did not retire revoked context")
        fullAccess = true
        try require(try !access.ownerSnapshot(expectedBinding: binding).calendarConnected, "Current owner Settings regrant revived selection")
        cases.append("current_owner_observation_disconnects_and_regrant_does_not_revive")
        let result: [String: Any] = ["kind": "macos_scoped_owner_boundary_with_injected_os_only", "result": "pass", "cases": cases,
            "realModelCalls": 0, "realEventKitCalls": 0, "iosAppRuns": 0]
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    }
    static func stale(_ action: () throws -> Void) throws {
        do { try action(); throw failure("Expected stale_context") }
        catch let error as GuguHostFailure { if error.code != "stale_context" { throw error } }
    }
    static func require(_ condition: Bool, _ message: String) throws { if !condition { throw failure(message) } }
    static func failure(_ message: String) -> GuguHostFailure { GuguHostFailure(code: "owner_boundary_regression", message: message) }
}
