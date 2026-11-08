import Foundation
import CryptoKit

private func require(_ condition: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !condition() { throw GuguHostFailure(code: "service_test_failed", message: text) }
}
private func wait<T>(_ work: (@escaping (T) -> Void) -> Void) throws -> T {
    let semaphore = DispatchSemaphore(value: 0); var result: T?
    work { result = $0; semaphore.signal() }
    try require(semaphore.wait(timeout: .now() + 10) == .success, "Native service callback timed out"); return result!
}
private final class Socket: GuguIOSRealtimeSocket {
    private let lock = NSLock()
    private var queued: [String] = []
    private var receiver: ((Result<String, Error>) -> Void)?
    func resume() {}
    func send(_ text: String, completion: @escaping (Error?) -> Void) {
        let frame = try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        completion(nil)
        let reply: [String: Any] = ["topic": frame["topic"]!, "event": "phx_reply", "ref": frame["ref"]!, "join_ref": frame["join_ref"] ?? NSNull(), "payload": ["status": "ok", "response": [:]]]
        let text = String(decoding: try! JSONSerialization.data(withJSONObject: reply), as: UTF8.self)
        lock.lock(); if let receiver { self.receiver = nil; lock.unlock(); receiver(.success(text)) } else { queued.append(text); lock.unlock() }
    }
    func receive(completion: @escaping (Result<String, Error>) -> Void) {
        lock.lock(); if queued.isEmpty { receiver = completion; lock.unlock() } else { let value = queued.removeFirst(); lock.unlock(); completion(.success(value)) }
    }
    func close() { lock.lock(); receiver = nil; lock.unlock() }
}
private final class Executor: GuguNativeToolExecutor {
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) { completion(["ok": false, "code": "fixture", "message": "No calendar execution in this test"]) }
}
@main struct HostServiceTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        var current = binding, localUI = true, publicationAvailable = true
        let access = GuguIOSOwnerAccess(root: root.appendingPathComponent("owner"), verifiedIdentity: {
            guard publicationAvailable else { throw GuguHostFailure(code: "stale_context", message: "Synthetic publication sealed") }
            return current
        }, requireOwnerUI: {
            guard localUI else { throw GuguHostFailure(code: "not_granted", message: "Synthetic foreground UI unavailable") }
        }, calendarHasFullAccess: { false }, revokeCalendarAccess: { _ in })
        let lifecycle = GuguIOSHostLifecycle(root: root.appendingPathComponent("journal"), verifiedIdentity: { current })
        let runtime = GuguPackagedRuntime(asset: asset, sha256: SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined(), piVersion: "1.4.0")
        let lock = NSLock(); var network = 0, sealedOrdinaryAttempts = 0, advertisements: [[String: Any]] = []
        let retirementId = UUID().uuidString.lowercased(), retirementDeadline = Date().addingTimeInterval(120)
        let service = try GuguIOSHostService(root: root.appendingPathComponent("service"), runtime: runtime, lifecycle: lifecycle, ownerAccess: access,
            configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
                guard publicationAvailable else {
                    lock.lock(); sealedOrdinaryAttempts += 1; lock.unlock()
                    throw GuguHostFailure(code: "stale_context", message: "Synthetic ordinary credentials sealed")
                }
                guard expected == current else { throw GuguHostFailure(code: "stale_context", message: "Synthetic publication changed") }
                return .init(binding: expected, accessToken: "synthetic-native-human", expiresAt: Date().addingTimeInterval(3600))
            }, executor: { _ in Executor() }, deviceMetadata: { ["label": "Synthetic iPhone", "hostname": "synthetic", "osName": "iOS fixture", "tier": "mobile"] }, brokerSend: { request, done in
                lock.lock(); network += 1; lock.unlock()
                let name = request.url!.lastPathComponent; var reply: Any = NSNull()
                if name == "recover_orphaned_device_commands" { reply = 0 }
                else if name == "fetch_fair_pending_device_commands" || request.httpMethod == "GET" { reply = [Any]() }
                else if name == "gugu_devices", let body = request.httpBody {
                    let value = try! JSONSerialization.jsonObject(with: body) as! [String: Any]
                    lock.lock(); advertisements.append(value); lock.unlock(); reply = [value]
                }
                done(try! JSONSerialization.data(withJSONObject: reply, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
            }, socketFactory: { _ in Socket() }, retirementAuthorization: { expected, id, operation in
                try require(expected == binding && id == retirementId, "Retirement permit escaped its original scope")
                return try .init(binding: expected, retirementId: id, operation: operation, accessToken: "synthetic-native-retirement", expiresAt: retirementDeadline)
            })
        let raw: [String: Any] = ["ownerId": owner, "deviceId": binding.deviceId, "installationId": install]
        var cases: [String] = []
        try require(network == 0, "Construction performed a cloud call")
        for field in ["accessToken", "refreshToken", "supabaseUrl", "grants"] {
            let rejected: [String: Any] = try wait { service.configure(["expectedBinding": raw, field: "synthetic-forbidden"], completion: $0) }
            try require((rejected["error"] as? [String: Any])?["code"] as? String == "invalid_args", "Legacy credential, URL or grant field was accepted")
        }
        try require(network == 0, "Rejected configuration sent a cloud request")
        cases.append("constructor_and_rejected_token_URL_grant_inputs_perform_zero_HTTP")
        for method in ["state", "call", "stop"] {
            let rejected: [String: Any] = try wait { done in
                if method == "state" { service.hostState(["ownerId": owner], completion: done) }
                else if method == "stop" { service.stopHost(["ownerId": owner], completion: done) }
                else { service.hostCall(["ownerId": owner, "id": UUID().uuidString.lowercased(), "channel": "appSettings.get", "args": ["notifications"]], completion: done) }
            }
            try require((rejected["error"] as? [String: Any])?["code"] as? String == "invalid_args", "Owner-only native wire remained a successful bypass")
        }
        let incomplete: [String: Any] = try wait { service.hostState(["expectedBinding": ["ownerId": owner]], completion: $0) }
        try require((incomplete["error"] as? [String: Any])?["code"] as? String == "invalid_args" && network == 0, "Incomplete native wire binding reached backend")
        cases.append("owner_only_and_incomplete_binding_wire_reject_before_HTTP")

        let configured: [String: Any] = try wait { service.configure(["expectedBinding": raw], completion: $0) }
        try require(configured["ownerId"] as? String == owner && configured["ready"] as? Bool == false && configured["errorCode"] as? String == "delivery_not_connected", "Partial delivery claimed ready")
        let read: (String, [Any]) throws -> [String: Any] = { channel, args in try wait { service.hostCall(["expectedBinding": raw, "id": UUID().uuidString.lowercased(), "channel": channel, "args": args], completion: $0) } }
        let absent = try read("appSettings.get", ["notifications"])
        try require((absent["error"] as? [String: Any])?["code"] as? String == "settings_unavailable", "Absent preference was inferred enabled")
        _ = try read("appSettings.update", ["notifications", ["enabled": false, "sound": true]])
        let value = try read("appSettings.get", ["notifications"])["result"] as? [String: Any]
        try require(value?["enabled"] as? Bool == false && value?["sound"] as? Bool == true, "Local notification readback differs")
        let disk = try GuguIOSBackendStore(root: root.appendingPathComponent("service/backend"), binding: binding)
        try require(try GuguIOSLocalAppSettings(store: disk).get()["enabled"] as? Bool == false, "Independent disk handle lost local preference")
        cases.append("named_local_notification_get_update_persist_without_ready_or_remote_defaults")
        localUI = false
        let denied = try read("appSettings.update", ["notifications", ["enabled": true, "sound": false]])
        try require((denied["error"] as? [String: Any])?["code"] as? String == "not_granted", "Non-foreground UI changed preference")
        localUI = true
        let invalid = try read("appSettings.update", ["notifications", ["enabled": 1, "sound": true]])
        try require((invalid["error"] as? [String: Any])?["code"] as? String == "invalid_args", "Numeric pseudo-boolean was persisted")
        let remote: [String: Any] = try wait { service.adapter.hostCall(ownerId: owner, id: UUID().uuidString.lowercased(), channel: "appSettings.get", args: ["notifications"], origin: .remoteAgent, expectedBinding: binding, completion: $0) }
        try require((remote["error"] as? [String: Any])?["code"] as? String == "not_granted", "Remote caller read local notification setting")
        cases.append("remote_settings_and_non_UI_or_invalid_writes_are_rejected")
        let anotherInstall = UUID().uuidString.lowercased(), old = current
        current = .init(ownerId: owner, deviceId: "phone-\(anotherInstall)-\(owner)", installationId: anotherInstall)
        let stale: [String: Any] = try wait { service.adapter.hostCall(ownerId: owner, id: UUID().uuidString.lowercased(), channel: "appSettings.get", args: ["notifications"], origin: .remoteAgent, expectedBinding: old, completion: $0) }
        try require((stale["error"] as? [String: Any])?["code"] as? String == "stale_context", "Old installation selected current owner")
        let staleState: [String: Any] = try wait { service.hostState(["expectedBinding": raw], completion: $0) }
        let staleCall: [String: Any] = try wait { service.hostCall(["expectedBinding": raw, "id": UUID().uuidString.lowercased(), "channel": "appSettings.get", "args": ["notifications"]], completion: $0) }
        let staleStop: [String: Any] = try wait { service.stopHost(["expectedBinding": raw], completion: $0) }
        try require([staleState, staleCall, staleStop].allSatisfy { ($0["error"] as? [String: Any])?["code"] as? String == "stale_context" } && !service.backend.stopped, "Old-install wire selected or stopped the replacement binding")
        cases.append("all_three_wire_entries_reject_original_binding_after_installation_change")
        let newStore = try GuguIOSBackendStore(root: root.appendingPathComponent("other-install"), binding: current)
        do { _ = try GuguIOSLocalAppSettings(store: newStore).get(); throw GuguHostFailure(code: "service_test_failed", message: "Preference crossed installations") }
        catch let error as GuguHostFailure { try require(error.code == "settings_unavailable", "New installation did not remain unknown") }
        current = old
        cases.append("captured_binding_and_local_settings_do_not_cross_installations")
        publicationAvailable = false
        let retirement: Result<Void, Error> = try wait { service.retireOwner(expectedBinding: binding, retirementId: retirementId, completion: $0) }
        try retirement.get()
        lock.lock(); let ordinaryAfterRetirement = sealedOrdinaryAttempts; lock.unlock()
        try require(ordinaryAfterRetirement == 0 && service.backend.stopped, "Sealed retirement borrowed ordinary credentials or left local backend running")
        publicationAvailable = true
        let afterRetirement: [String: Any] = try wait { service.hostState(["expectedBinding": raw], completion: $0) }
        try require((afterRetirement["error"] as? [String: Any])?["code"] as? String == "host_not_ready", "Retired same-binding hostState returned a configured stopped host")
        let reopened: [String: Any] = try wait { service.configure(["expectedBinding": raw], completion: $0) }
        try require(reopened["ownerId"] as? String == owner && reopened["errorCode"] as? String == "delivery_not_connected", "Explicit same-binding configuration did not reopen the native host")
        cases.append("sealed_service_retirement_requires_same_binding_reconfigure_without_ordinary_credentials")
        let stopped: [String: Any] = try wait { service.stopHost(["expectedBinding": raw], completion: $0) }
        try require(stopped.isEmpty, "Known clean local stop failed")
        lock.lock(); let ads = advertisements; lock.unlock()
        try require(!ads.isEmpty && ads.allSatisfy { ($0["capabilities"] as? [String: Any])?["host_runtime_capability"] as? Int == 0 }, "Partial delivery advertised a host capability")
        cases.append("actual_private_subscriptions_and_heartbeat_do_not_advertise_missing_delivery")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "actual_Pi_JSC_native_service_APFS_with_synthetic_HTTP_and_sockets", "cases": cases, "realCloudHTTPCalls": 0, "realModelCalls": 0, "iosAppRuns": 0], options: [.sortedKeys, .prettyPrinted]), as: UTF8.self))
    }
}
