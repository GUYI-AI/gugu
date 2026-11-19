import Foundation
import Capacitor

@objc(GuguAccountClosureV2Plugin)
final class GuguAccountClosureV2Plugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GuguAccountClosureV2Plugin"
    let jsName = "GuguAccountClosureV2"
    let pluginMethods = ["readPolicy", "discover", "capture", "sendCode", "prepare", "confirm", "recover", "cancel", "finalizeOperation"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let service: GuguIOSClosureV2Facade
    private let foreground: () throws -> Void
    init(service: GuguIOSClosureV2Facade, foreground: @escaping () throws -> Void) {
        self.service = service; self.foreground = foreground; super.init()
    }
    private func perform(_ call: CAPPluginCall, _ action: GuguIOSClosureV2Facade.Action,
                         hasHandle: Bool = false, confirmation: Bool = false) {
        do {
            let allowed: Set<String> = confirmation ? ["handle", "code", "acknowledgeForfeit"] : hasHandle ? ["handle"] : []
            guard Set(call.options.keys) == allowed else { throw GuguIOSClosureV2Operation.failure("invalid_request") }
            // Automatic discovery/result/finalization also work before authenticated Settings exists.
            if [.capture, .sendCode, .prepare, .confirm, .cancel].contains(action) { try foreground() }
            var handle: GuguIOSClosureV2Handle?
            if hasHandle {
                guard let raw = call.getObject("handle"), Set(raw.keys) == ["localOperationId", "nativeGeneration", "localRevision"],
                      let bytes = try? JSONSerialization.data(withJSONObject: raw),
                      let decoded = try? JSONDecoder().decode(GuguIOSClosureV2Handle.self, from: bytes),
                      UUID(uuidString: decoded.nativeGeneration)?.uuidString.lowercased() == decoded.nativeGeneration,
                      !decoded.localOperationId.isEmpty, decoded.localOperationId.utf8.count <= 256,
                      (1...9_007_199_254_740_991).contains(decoded.localRevision) else { throw GuguIOSClosureV2Operation.failure("invalid_scope") }
                handle = decoded
            }
            let code = confirmation ? call.getString("code") : nil
            let consent = call.getBool("acknowledgeForfeit") == true
            if confirmation && (code == nil || !consent) { throw GuguIOSClosureV2Operation.failure("invalid_request") }
            Task {
                do {
                    let result = try await service.execute(action, handle: handle, code: code, acknowledgeForfeit: consent)
                    if action == .discover { call.resolve(["snapshot": result as Any? ?? NSNull()]) }
                    else if let result { call.resolve(result) }
                    else { throw GuguIOSClosureV2Operation.failure("closure_unavailable") }
                } catch { reject(call, error) }
            }
        } catch { reject(call, error) }
    }
    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let allowed: Set<String> = ["closure_context_missing", "closure_not_prepared", "wrong_local_owner", "scope_conflict", "receipt_missing", "invalid_scope",
            "closure_storage_unavailable", "closure_busy", "closure_unavailable", "closure_not_available", "closure_recovery_required", "closure_not_complete",
            "unauthorized", "invalid_request", "verification_failed", "rate_limited", "operation_busy", "request_active", "state_conflict", "not_found",
            "preparation_unavailable", "outcome_unknown", "email_outcome_unknown"]
        let code = (error as? GuguHostFailure)?.code ?? "closure_unavailable"
        call.reject("Account closure could not be completed", allowed.contains(code) ? code : "closure_unavailable")
    }
    @objc func readPolicy(_ call: CAPPluginCall) { perform(call, .policy) }
    @objc func discover(_ call: CAPPluginCall) { perform(call, .discover) }
    @objc func capture(_ call: CAPPluginCall) { perform(call, .capture) }
    @objc func sendCode(_ call: CAPPluginCall) { perform(call, .sendCode, hasHandle: true) }
    @objc func prepare(_ call: CAPPluginCall) { perform(call, .prepare, hasHandle: true) }
    @objc func confirm(_ call: CAPPluginCall) { perform(call, .confirm, hasHandle: true, confirmation: true) }
    @objc func recover(_ call: CAPPluginCall) { perform(call, .recover, hasHandle: true) }
    @objc func cancel(_ call: CAPPluginCall) { perform(call, .cancel, hasHandle: true) }
    @objc func finalizeOperation(_ call: CAPPluginCall) { perform(call, .finalize, hasHandle: true) }
}
