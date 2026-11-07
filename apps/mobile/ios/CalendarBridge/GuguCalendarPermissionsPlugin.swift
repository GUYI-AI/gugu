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
    ]
    private let calendarStore: EventKitPhoneCalendarStore
    private let checkOwner: () throws -> Void

    /// Must validate the current native owner/installation and this local connection UI.
    /// There is intentionally no initializer that installs a permissive authorization closure.
    init(store: EventKitPhoneCalendarStore, checkOwner: @escaping () throws -> Void) {
        calendarStore = store
        self.checkOwner = checkOwner
        super.init()
    }

    private func state() -> [String: Any] {
        let access = calendarStore.authorization
        return ["authorization": access.rawValue,
                "os_readable": access == .fullAccess,
                "os_writable": access == .fullAccess || access == .writeOnly]
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if let failure = error as? GuguHostFailure { call.reject(failure.message, failure.code) }
        else if let failure = error as? PhoneCalendarFailure { call.reject(failure.message, failure.code) }
        else { call.reject("Calendar permission request failed", "execution_failed") }
    }

    @objc func status(_ call: CAPPluginCall) {
        do {
            try checkOwner()
            call.resolve(state())
        } catch { reject(call, error) }
    }

    @objc func connect(_ call: CAPPluginCall) {
        // No caller-supplied owner, confirmed flag or category selection can replace checkOwner.
        calendarStore.requestAccessFromOwnerUI(checkOwner: checkOwner) { result in
            switch result {
            case .success:
                call.resolve(self.state())
            case let .failure(error):
                self.reject(call, error)
            }
        }
    }
}
#endif
