import Foundation

@main struct HostBindingTests {
    static func main() throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        let proper = "phone-\(install)-\(owner)"
        let cases: [(String, GuguIOSHostBinding, Bool)] = [
            ("existing_phone_device_id", .init(ownerId: owner, deviceId: proper, installationId: install), true),
            ("device_id_for_different_owner", .init(ownerId: UUID().uuidString, deviceId: proper, installationId: install), false),
            ("device_id_for_different_installation", .init(ownerId: owner, deviceId: proper, installationId: UUID().uuidString), false),
            ("invented_uuid_device_id", .init(ownerId: owner, deviceId: UUID().uuidString, installationId: install), false),
            ("invalid_owner_uuid", .init(ownerId: "owner", deviceId: "phone-\(install)-owner", installationId: install), false),
            ("invalid_installation_uuid", .init(ownerId: owner, deviceId: "phone-install-\(owner)", installationId: "install"), false),
        ]
        var results: [[String: Any]] = []
        for (name, binding, expected) in cases {
            let root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(name)
            let access = GuguIOSOwnerAccess(root: root, verifiedIdentity: { binding }, requireOwnerUI: {}, calendarHasFullAccess: { false }, revokeCalendarAccess: { _ in})
            var accepted = false
            do { _ = try access.ownerSnapshot(); accepted = true } catch {}
            results.append(["name": name, "accepted": accepted, "expected": expected, "result": accepted == expected ? "pass" : "fail"])
        }
        let failed = results.contains { $0["result"] as? String == "fail" }
        print(String(data: try JSONSerialization.data(withJSONObject: ["kind": "native_phone_binding_only", "cases": results,
            "result": failed ? "fail" : "pass", "realModelCalls": 0, "realEventKitCalls": 0], options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
        if failed { exit(1) }
    }
}
