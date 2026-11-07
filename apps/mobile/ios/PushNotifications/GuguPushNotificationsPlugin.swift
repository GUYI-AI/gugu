#if os(iOS)
import Capacitor
import Foundation

@objc(GuguPushNotificationsPlugin)
final class GuguPushNotificationsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GuguPushNotificationsPlugin"
    let jsName = "GuguPushNotifications"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "revoke", returnType: CAPPluginReturnPromise),
    ]
    private let client: GuguPushClient
    init(client: GuguPushClient) { self.client = client; super.init() }

    private func expected(_ call: CAPPluginCall) throws -> GuguPushBinding {
        guard let object = call.getObject("expectedBinding"), let owner = object["ownerId"] as? String,
              let device = object["deviceId"] as? String, let install = object["installationId"] as? String else {
            throw GuguPushFailure(code: "invalid_args", message: "Current notification owner binding is required")
        }
        let value = GuguPushBinding(ownerId: owner, deviceId: device, installationId: install)
        try value.validate(); return value
    }

    private func run(_ call: CAPPluginCall, operation: @escaping @MainActor (GuguPushBinding) async throws -> GuguPushSnapshot) {
        do {
            let binding = try expected(call)
            Task { @MainActor in
                do { call.resolve(try await operation(binding).json) }
                catch let failure as GuguPushFailure { call.reject(failure.message, failure.code) }
                catch { call.reject("Notification operation was not confirmed", "push_failed") }
            }
        } catch let failure as GuguPushFailure { call.reject(failure.message, failure.code) }
        catch { call.reject("Notification operation was not confirmed", "push_failed") }
    }

    @objc func status(_ call: CAPPluginCall) {
        run(call) { try await self.client.status(expectedBinding: $0) }
    }
    @objc func requestAuthorization(_ call: CAPPluginCall) {
        run(call) { try await self.client.requestAuthorization(expectedBinding: $0) }
    }
    @objc func register(_ call: CAPPluginCall) {
        run(call) { try await self.client.register(expectedBinding: $0) }
    }
    @objc func revoke(_ call: CAPPluginCall) {
        run(call) { try await self.client.revoke(expectedBinding: $0) }
    }
}
#endif
