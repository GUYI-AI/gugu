#if os(iOS)
import Capacitor
import Foundation
#if canImport(GuguPhoneCalendar)
import GuguPhoneCalendar
#endif

/// Owner renderer UI only; these methods are absent from the agent tool executor's allowlist.
@objc(GuguCalendarPermissionsPlugin)
final class GuguCalendarPermissionsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GuguCalendarPermissionsPlugin"
    let jsName = "GuguCalendarPermissions"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
    ]
    private let calendarStore: EventKitPhoneCalendarStore
    private let connection: GuguCalendarConnection

    /// Must validate the current native owner/installation and this local connection UI.
    /// There is intentionally no initializer that installs a permissive authorization closure.
    init(store: EventKitPhoneCalendarStore, ownerAccess: GuguIOSOwnerAccess) {
        calendarStore = store
        connection = GuguCalendarConnection(ownerAccess: ownerAccess,
            hasFullAccess: { store.authorization == .fullAccess },
            requestAccess: { checkOwner, completion in
                store.requestAccessFromOwnerUI(checkOwner: checkOwner) { completion($0.map { _ in () }) }
            })
        super.init()
    }

    private func state(_ snapshot: GuguIOSOwnerSnapshot) -> [String: Any] {
        let access = calendarStore.authorization
        return ["authorization": access.rawValue,
                "os_readable": access == .fullAccess,
                "os_writable": access == .fullAccess || access == .writeOnly,
                "binding": ["ownerId": snapshot.binding.ownerId, "deviceId": snapshot.binding.deviceId,
                            "installationId": snapshot.binding.installationId],
                "calendarConnected": snapshot.calendarConnected,
                "calendarRevision": snapshot.calendarRevision as Any? ?? NSNull()]
    }

    private func expectedBinding(_ call: CAPPluginCall) throws -> GuguIOSHostBinding {
        guard let value = call.getObject("expectedBinding"),
              let owner = value["ownerId"] as? String,
              let device = value["deviceId"] as? String,
              let install = value["installationId"] as? String else {
            throw GuguHostFailure(code: "invalid_args", message: "Current native owner snapshot is required")
        }
        // Caller data is only an equality precondition, never an identity authority.
        return GuguIOSHostBinding(ownerId: owner, deviceId: device, installationId: install)
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if let failure = error as? GuguHostFailure { call.reject(failure.message, failure.code) }
        else if let failure = error as? PhoneCalendarFailure { call.reject(failure.message, failure.code) }
        else { call.reject("Calendar permission request failed", "execution_failed") }
    }

    @objc func status(_ call: CAPPluginCall) {
        do {
            guard let owner = call.getString("ownerId") else {
                throw GuguHostFailure(code: "invalid_args", message: "Current owner is required")
            }
            call.resolve(state(try connection.snapshot(ownerId: owner)))
        } catch { reject(call, error) }
    }

    @objc func connect(_ call: CAPPluginCall) {
        do {
            let binding = try expectedBinding(call)
            connection.connect(expectedBinding: binding) { result in
                do {
                    call.resolve(self.state(try result.get()))
                } catch { self.reject(call, error) }
            }
        } catch { reject(call, error) }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        do {
            let binding = try expectedBinding(call)
            call.resolve(state(try connection.disconnect(expectedBinding: binding)))
        } catch { reject(call, error) }
    }
}
#endif
