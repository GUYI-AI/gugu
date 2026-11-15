import Foundation
import CoreFoundation

/// Local owner + installation custody. This never reads a cloud/remote machine
/// preference or infers APNs authorization from an application preference.
final class GuguIOSLocalAppSettings {
    private let store: GuguIOSBackendStore
    init(store: GuguIOSBackendStore) { self.store = store }
    func get() throws -> [String: Any] {
        guard let values = try store.snapshot()["appSettings"] as? [String: Any], let notifications = values["notifications"] as? [String: Any] else {
            throw GuguHostFailure(code: "settings_unavailable", message: "Local phone notification preference has not been persisted")
        }
        try validate(notifications); return notifications
    }
    func getWithMeta() throws -> [String: Any] {
        let value = try get()
        // These metadata defaults match shared core/settings/settings-registry.ts.
        // They do not initialize an absent phone preference or claim OS permission.
        return ["value": value, "defaults": ["enabled": true, "sound": true], "overrides": value]
    }
    func update(_ value: [String: Any]) throws {
        try validate(value)
        try store.transaction { state in
            var settings = state["appSettings"] as? [String: Any] ?? [:]
            settings["notifications"] = value; state["appSettings"] = settings
        }
    }
    private func validate(_ value: [String: Any]) throws {
        guard Set(value.keys) == Set(["enabled", "sound"]), ["enabled", "sound"].allSatisfy({ key in
            guard let number = value[key] as? NSNumber else { return false }
            return CFGetTypeID(number) == CFBooleanGetTypeID()
        }) else { throw GuguHostFailure(code: "invalid_args", message: "Notification enabled and sound must be explicit booleans") }
    }
}
