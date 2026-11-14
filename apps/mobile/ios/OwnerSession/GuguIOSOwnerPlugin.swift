#if os(iOS)
import Capacitor
import Foundation

@objc(GuguIOSOwnerPlugin)
final class GuguIOSOwnerPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GuguIOSOwnerPlugin"
    let jsName = "GuguIOSOwner"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "publishSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBinding", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireSession", returnType: CAPPluginReturnPromise),
    ]
    private let ownerSession: GuguIOSOwnerSession
    init(ownerSession: GuguIOSOwnerSession) { self.ownerSession = ownerSession; super.init() }

    private func owner(_ call: CAPPluginCall) throws -> String {
        guard let owner = call.getString("ownerId"), UUID(uuidString: owner)?.uuidString.lowercased() == owner else {
            throw GuguHostFailure(code: "invalid_args", message: "Current owner is required")
        }
        return owner
    }
    private func binding(_ value: GuguIOSHostBinding) -> [String: String] {
        ["ownerId": value.ownerId, "deviceId": value.deviceId, "installationId": value.installationId]
    }
    private func reject(_ call: CAPPluginCall, _ error: Error) {
        if let failure = error as? GuguHostFailure { call.reject(failure.message, failure.code) }
        else { call.reject("Native owner publication failed", "owner_unavailable") }
    }

    @objc func publishSession(_ call: CAPPluginCall) {
        do {
            let id = try owner(call)
            guard let access = call.getString("accessToken"), access.utf8.count <= 65536 else {
                throw GuguHostFailure(code: "invalid_args", message: "Committed access token is required")
            }
            ownerSession.publish(ownerId: id, accessToken: access) { result in
                do { call.resolve(["available": true, "binding": self.binding(try result.get())]) }
                catch { self.reject(call, error) }
            }
        } catch { reject(call, error) }
    }

    @objc func getBinding(_ call: CAPPluginCall) {
        do {
            let current = try ownerSession.snapshot(expectedOwnerId: owner(call))
            call.resolve(["available": current != nil, "binding": current.map(binding) as Any? ?? NSNull()])
        } catch { reject(call, error) }
    }

    @objc func retireSession(_ call: CAPPluginCall) {
        do {
            ownerSession.retire(expectedOwnerId: try owner(call)) { result in
                do { try result.get(); call.resolve(["retired": true]) }
                catch { self.reject(call, error) }
            }
        } catch { reject(call, error) }
    }
}
#endif
