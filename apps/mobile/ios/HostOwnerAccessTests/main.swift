import Foundation

@main struct HostOwnerAccessTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let original = binding()
        var current = original, foregroundOwner = true, fullAccess = false, revoked = 0
        let access = GuguIOSOwnerAccess(root: root, verifiedIdentity: { current }, requireOwnerUI: {
            if !foregroundOwner { throw GuguHostFailure(code: "not_granted", message: "Fixture is not owner UI") }
        }, calendarHasFullAccess: { fullAccess }, revokeCalendarAccess: { revoked += 1 })
        var cases: [String] = []
        try require(try !access.calendarEnabled(), "Missing choice must be disconnected")
        foregroundOwner = false
        try reject("not_granted") { _ = try access.beginCalendarConnection(expectedBinding: original) }
        try require(revoked == 0, "Non-owner mutated connection")
        foregroundOwner = true
        cases.append("default_off_and_owner_ui_guard")

        let first = try access.beginCalendarConnection(expectedBinding: original)
        try require(revoked == 1 && (try !access.calendarEnabled()), "Connect did not revoke and persist false")
        try reject("os_permission") { _ = try access.finishCalendarConnection(attempt: first) }
        try require(try !access.calendarEnabled(), "Missing full access became connected")
        cases.append("begin_revokes_before_permission_and_full_access_required")

        fullAccess = true
        let connected = try access.finishCalendarConnection(attempt: first)
        try require(connected.binding == original && connected.calendarConnected, "Connection was not read back")
        try reject("stale_context") { _ = try access.finishCalendarConnection(attempt: first) }
        cases.append("full_access_connect_and_one_use_attempt")

        let older = try access.beginCalendarConnection(expectedBinding: original)
        let newest = try access.beginCalendarConnection(expectedBinding: original)
        try reject("stale_context") { _ = try access.finishCalendarConnection(attempt: older) }
        _ = try access.finishCalendarConnection(attempt: newest)
        cases.append("reconnect_invalidates_old_attempt")

        let pending = try access.beginCalendarConnection(expectedBinding: original)
        current = binding()
        try reject("stale_context") { _ = try access.finishCalendarConnection(attempt: pending) }
        try require(try !access.calendarEnabled(), "New owner inherited category choice")
        current = original
        try require(try !access.calendarEnabled(), "Late callback reconnected retired owner")
        cases.append("account_switch_rejects_late_connect")

        _ = try access.finishCalendarConnection(attempt: pending)
        _ = try access.disconnectCalendar(expectedBinding: original)
        let reopened = GuguIOSOwnerAccess(root: root, verifiedIdentity: { current }, requireOwnerUI: {}, calendarHasFullAccess: { true }, revokeCalendarAccess: {})
        try require(try !reopened.calendarEnabled(), "Disconnected choice did not survive reopening")
        cases.append("disconnect_persists_across_handles")
        let file = root.appendingPathComponent(original.ownerId).appendingPathComponent("calendar-connection.json")
        let bytes = Data("corrupt-fixture".utf8); try bytes.write(to: file)
        var failed = false
        do { _ = try access.ownerSnapshot() } catch { failed = true }
        try require(failed && (try Data(contentsOf: file)) == bytes, "Corrupt choice was reset or allowed")
        cases.append("corrupt_category_fails_without_reset")
        let result: [String: Any] = ["kind": "macos_owner_category_with_injected_identity_and_permission_only", "cases": cases,
            "result": "pass", "realModelCalls": 0, "realEventKitCalls": 0, "verifiedLoginRuns": 0]
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
    }
    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw GuguHostFailure(code: "owner_access_regression", message: message) }
    }
    static func binding() -> GuguIOSHostBinding {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        return GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
    }
    static func reject(_ code: String, _ action: () throws -> Void) throws {
        do { try action(); throw GuguHostFailure(code: "owner_access_regression", message: "Expected \(code)") }
        catch let error as GuguHostFailure { if error.code != code { throw error } }
    }
}
