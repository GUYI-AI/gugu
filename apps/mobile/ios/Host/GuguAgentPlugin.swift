#if os(iOS)
import Capacitor
import Foundation

@objc(GuguAgentPlugin)
final class GuguAgentPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GuguAgentPlugin"
    let jsName = "GuguAgent"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hostState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hostCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopHost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authSession", returnType: CAPPluginReturnPromise),
    ]
    private let service: GuguIOSHostService
    init(service: GuguIOSHostService) {
        self.service = service; super.init()
        service.observeState { [weak self] state in DispatchQueue.main.async { self?.notifyListeners("hostState", data: state) } }
    }
    private func settle(_ call: CAPPluginCall, _ value: [String: Any]) {
        if let error = value["error"] as? [String: Any] { call.reject(error["message"] as? String ?? "Native host failed", error["code"] as? String ?? "host_failed") }
        else { call.resolve(value) }
    }
    @objc func configure(_ call: CAPPluginCall) { service.configure(call.jsObjectRepresentation) { self.settle(call, $0) } }
    @objc func hostState(_ call: CAPPluginCall) { service.hostState(call.jsObjectRepresentation) { self.settle(call, $0) } }
    @objc func hostCall(_ call: CAPPluginCall) { service.hostCall(call.jsObjectRepresentation) { call.resolve($0) } }
    @objc func stopHost(_ call: CAPPluginCall) { service.stopHost(call.jsObjectRepresentation) { self.settle(call, $0) } }
    @objc func authSession(_ call: CAPPluginCall) {
        // Shared phoneHostAuth still carries a legacy refreshToken argument.
        // Read only the action; never materialize/pass that credential object.
        guard let action = call.getString("action") else { call.reject("Auth delegation action is required", "invalid_args"); return }
        service.authSession(["action": action]) { response in
            switch response {
            case .success(let value): call.resolve(value)
            case .failure(let error): let safe = GuguIOSNativeBackend.safe(error); call.reject(safe.message, safe.code)
            }
        }
    }
}
#endif
