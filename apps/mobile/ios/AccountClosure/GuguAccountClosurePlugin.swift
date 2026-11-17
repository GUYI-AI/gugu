import Foundation
import Capacitor

@objc(GuguAccountClosurePlugin)
public final class GuguAccountClosurePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GuguAccountClosurePlugin"
    public let jsName = "GuguAccountClosure"
    public let pluginMethods: [CAPPluginMethod] = ["put", "get", "remove", "eraseLocal"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let service: GuguIOSAccountClosure
    private let foreground: () throws -> Void
    private let queue = DispatchQueue(label: "app.gugu.account-closure")
    init(service: GuguIOSAccountClosure, foreground: @escaping () throws -> Void) {
        self.service = service; self.foreground = foreground; super.init()
    }
    private func scope(_ call: CAPPluginCall, receipt: Bool = false) throws -> GuguIOSClosureScope {
        try foreground()
        let allowed: Set<String> = receipt ? ["ownerId", "localOperationId", "receipt"] : ["ownerId", "localOperationId"]
        guard Set(call.options.keys).isSubset(of: allowed), let owner = call.getString("ownerId"),
              let operation = call.getString("localOperationId") else { throw GuguIOSAccountClosure.failure("invalid_scope") }
        let scope = GuguIOSClosureScope(ownerId: owner, localOperationId: operation); try scope.validate(); return scope
    }
    private func perform(_ call: CAPPluginCall, receipt: Bool = false,
                         body: @escaping (GuguIOSClosureScope) throws -> [String: Any]) {
        do {
            let captured = try scope(call, receipt: receipt)
            queue.async {
                do { call.resolve(try body(captured)) }
                catch { self.reject(call, error) }
            }
        } catch { reject(call, error) }
    }
    private func reject(_ call: CAPPluginCall, _ error: Error) {
        // Never forward Keychain/JSON/opaque receipt errors or values to logs.
        call.reject("Local account closure data could not be accessed or cleaned", Self.publicCode(error))
    }
    static func publicCode(_ error: Error) -> String {
        if let failure = error as? GuguHostFailure { return failure.code }
        // Push's original cleanup gate uses its own native failure type. Preserve
        // the shared precondition code without forwarding its message or values.
        if let failure = error as? GuguPushFailure, failure.code == "closure_not_prepared" { return failure.code }
        return "closure_storage_unavailable"
    }
    @objc public func put(_ call: CAPPluginCall) {
        guard let value = call.getString("receipt") else { reject(call, GuguIOSAccountClosure.failure("invalid_receipt")); return }
        perform(call, receipt: true) { scope in try self.service.put(scope, receipt: value); return [:] }
    }
    @objc public func get(_ call: CAPPluginCall) {
        perform(call) { scope in ["value": try self.service.get(scope) as Any? ?? NSNull()] }
    }
    @objc public func remove(_ call: CAPPluginCall) {
        perform(call) { scope in try self.service.remove(scope); return [:] }
    }
    @objc public func eraseLocal(_ call: CAPPluginCall) {
        perform(call) { scope in
            let value = try self.service.eraseLocal(scope)
            return ["status": value.status, "retainedUnattributed": value.retainedUnattributed]
        }
    }
}
