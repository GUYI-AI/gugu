import Foundation

private func require(_ condition: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !condition() { throw GuguHostFailure(code: "retirement_test_failed", message: text) }
}
private func wait<T>(_ work: (@escaping (T) -> Void) -> Void) throws -> T {
    let semaphore = DispatchSemaphore(value: 0); var value: T?
    work { value = $0; semaphore.signal() }
    try require(semaphore.wait(timeout: .now() + 15) == .success, "Retirement callback timed out"); return value!
}
private final class Executor: GuguNativeToolExecutor {
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) { completion(["ok": false, "code": "unexpected", "message": "No native tool runs during cleanup"]) }
}
private final class Fixture {
    let root: URL, binding: GuguIOSHostBinding, store: GuguIOSBackendStore
    let retirementId = UUID().uuidString.lowercased(), secret = "synthetic-retirement-native-only", expiry = Date().addingTimeInterval(120)
    let configuration = GuguIOSBackendConfiguration(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public")
    var publication: GuguIOSHostBinding?, allowed = true, wrong = "", failCheckpoint = false, revokeAfterLease = false
    var replaceBeforePatch = false, losePatchACK = false, device: [String: Any]?, knownIDs: Set<String> = []
    var sent: [String] = [], patches = 0, normalCredentialCalls = 0
    init(_ root: URL) throws {
        self.root = root
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        store = try .init(root: root.appendingPathComponent("backend"), binding: binding)
        device = ["device_id": binding.deviceId, "user_id": owner, "updated_at": "2026-11-08T00:00:00.000Z", "capabilities": ["host_kind": "phone", "runtimes": ["pi"], "host_runtime_capability": 1, "unrelated": "survives"]]
    }
    func lease(known: Bool = true) throws -> String {
        let job = UUID().uuidString.lowercased(), id = UUID().uuidString.lowercased()
        _ = try store.admit("leases", id: "issue:\(job)", fingerprint: job) {
            var row: [String: Any] = ["jobId": job, "agentId": UUID().uuidString.lowercased(), "sessionId": UUID().uuidString.lowercased(), "status": known ? "cleanup_required" : "issue_uncertain"]
            if known { row["leaseId"] = id }; return row
        }
        if known { knownIDs.insert(id) }; return job
    }
    lazy var authorize: GuguIOSRetirementCleanup.Authorize = { expected, id, operation in
        guard self.allowed else { throw GuguHostFailure(code: "retirement_not_authorized", message: "Synthetic permit retired") }
        let binding = self.wrong == "binding" ? GuguIOSHostBinding(ownerId: UUID().uuidString.lowercased(), deviceId: "other-phone", installationId: UUID().uuidString.lowercased()) : expected
        return try .init(binding: binding, retirementId: self.wrong == "id" ? UUID().uuidString.lowercased() : id,
            operation: self.wrong == "operation" ? .withdrawOwnedDevice : operation, accessToken: self.secret,
            expiresAt: self.wrong == "expired" ? Date().addingTimeInterval(-1) : self.expiry)
    }
    lazy var send: GuguIOSCloudBroker.Send = { request, done in
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        var raw: Any = ["ok": true], status = 200
        if request.url!.lastPathComponent == "model-access" {
            let action = body["action"] as! String, lease = body["session_id"] as! String
            guard ["checkpoint", "revoke"].contains(action), self.knownIDs.contains(lease) else { fatalError("Unexpected inference or unregistered cleanup operation") }
            self.sent.append(action)
            if action == "checkpoint", self.failCheckpoint { status = 503 }
            if action == "revoke", self.revokeAfterLease { self.allowed = false }
        } else {
            guard request.url!.lastPathComponent == "gugu_devices" else { fatalError("Unexpected cleanup endpoint") }
            let query = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
            guard query["device_id"] == "eq.\(self.binding.deviceId)", query["user_id"] == "eq.\(self.binding.ownerId)" else { fatalError("Cleanup targeted a different device or owner") }
            if request.httpMethod == "GET" { self.sent.append("readDevice"); raw = self.device.map { [$0] } ?? [] }
            else {
                self.sent.append("withdrawDevice"); self.patches += 1
                if self.replaceBeforePatch {
                    self.replaceBeforePatch = false; self.device?["updated_at"] = "2026-11-08T01:00:00.000Z"
                    self.device?["capabilities"] = ["host_kind": "phone", "runtimes": ["pi"], "host_runtime_capability": 1, "replacement": true]
                }
                if let version = self.device?["updated_at"] as? String, query["updated_at"] == "eq.\(version)" {
                    self.device?["updated_at"] = body["updated_at"]; self.device?["capabilities"] = body["capabilities"]
                    raw = [["device_id": self.binding.deviceId]]
                    if self.losePatchACK { self.losePatchACK = false; done(nil, nil, URLError(.networkConnectionLost)); return }
                } else { raw = [[String: Any]]() }
            }
        }
        done(try! JSONSerialization.data(withJSONObject: raw), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil), nil)
    }
    func cleanup() throws -> GuguIOSRetirementCleanup { try .init(root: root, configuration: configuration, authorize: authorize, send: send) }
    func run(_ cleanup: GuguIOSRetirementCleanup) throws -> Result<Void, Error> { try wait { cleanup.retire(expectedBinding: binding, retirementId: retirementId, completion: $0) } }
    func service() throws -> GuguIOSHostService {
        let lifecycle = GuguIOSHostLifecycle(root: root.appendingPathComponent("host"), verifiedIdentity: {
            guard let binding = self.publication else { throw GuguHostFailure(code: "auth_unavailable", message: "No active publication") }; return binding
        })
        let owner = GuguIOSOwnerAccess(root: root.appendingPathComponent("owner"), verifiedIdentity: {
            guard let binding = self.publication else { throw GuguHostFailure(code: "auth_unavailable", message: "No active publication") }; return binding
        }, requireOwnerUI: {}, calendarHasFullAccess: { true }, revokeCalendarAccess: { try lifecycle.revokeCalendarAccess(binding: $0) })
        return try .init(root: root, runtime: .init(asset: Data(), sha256: "unused-cold-runtime", piVersion: "1.4.0"), lifecycle: lifecycle, ownerAccess: owner,
            configuration: configuration, credentials: { _ in self.normalCredentialCalls += 1; throw GuguHostFailure(code: "auth_unavailable", message: "Ordinary publication is sealed") },
            executor: { _ in Executor() }, deviceMetadata: { [:] }, brokerSend: send, retirementAuthorization: authorize)
    }
}
@main struct HostRetirementTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]); var cases: [String] = []
        let cold = try Fixture(root.appendingPathComponent("cold")); let job = try cold.lease(), service = try cold.service()
        try require(cold.sent.isEmpty, "Construction ran cleanup automatically")
        let done: Result<Void, Error> = try wait { service.retireOwner(expectedBinding: cold.binding, retirementId: cold.retirementId, completion: $0) }; _ = try done.get()
        try require(cold.normalCredentialCalls == 0 && cold.sent == ["checkpoint", "revoke", "readDevice", "withdrawDevice"], "Cold sealed cleanup borrowed ordinary publication or performed another operation")
        try require(try cold.store.record("leases", id: "issue:\(job)")?["status"] as? String == "settled", "Known cold lease receipt was not settled")
        let caps = cold.device?["capabilities"] as? [String: Any]
        try require(caps?["host_runtime_capability"] as? Int == 0 && caps?["unrelated"] as? String == "survives", "Device withdrawal changed unrelated capabilities")
        let before = cold.sent
        let repeated: Result<Void, Error> = try wait { service.retireOwner(expectedBinding: cold.binding, retirementId: cold.retirementId, completion: $0) }; _ = try repeated.get()
        try require(cold.sent == before, "Completed original retirement replayed HTTP")
        cases.append("cold_no_publication_cleanup_uses_only_scoped_permit_and_reuses_original_retirement_ID")
        let ticket = try cold.authorize(cold.binding, cold.retirementId, .readOwnedDevice)
        let disk = String(decoding: try Data(contentsOf: root.appendingPathComponent("cold/backend/\(cold.binding.ownerId)/backend.json")), as: UTF8.self)
        try require(!disk.contains(cold.secret) && !String(describing: ticket).contains(cold.secret) && !String(reflecting: ticket).contains(cold.secret), "Retirement credential escaped into durable state or descriptions")
        cases.append("native_retirement_credential_is_absent_from_disk_and_debug_descriptions")
        let limited = try GuguIOSRetirementHTTP(configuration: cold.configuration, store: cold.store, retirementId: cold.retirementId, authorize: cold.authorize, send: cold.send)
        let foreignLease: Result<Any, Error> = try wait { limited.perform(.revokeLease(UUID().uuidString.lowercased()), completion: $0) }
        guard case .failure = foreignLease else { throw GuguHostFailure(code: "retirement_test_failed", message: "Unregistered lease was accepted by cleanup HTTP") }
        try require(cold.sent == before, "Unregistered lease caused a cleanup request")
        cases.append("unregistered_lease_ID_is_rejected_before_HTTP_even_with_an_otherwise_valid_permit")

        for wrong in ["binding", "id", "operation", "expired"] {
            let f = try Fixture(root.appendingPathComponent(wrong)); f.wrong = wrong
            let outcome = try f.run(f.cleanup()); guard case .failure = outcome else { throw GuguHostFailure(code: "retirement_test_failed", message: "Invalid permit succeeded") }
            try require(f.sent.isEmpty, "Invalid retirement permit sent HTTP")
        }
        cases.append("wrong_binding_transaction_operation_and_expired_permits_send_zero_HTTP")
        let unknown = try Fixture(root.appendingPathComponent("unknown")); _ = try unknown.lease(known: false)
        let uncertain = try unknown.run(unknown.cleanup())
        guard case .failure(let uncertainty as GuguHostFailure) = uncertain, uncertainty.code == "model_issue_uncertain" else { throw GuguHostFailure(code: "retirement_test_failed", message: "Unknown issue was marked clean") }
        try require(!unknown.sent.contains("checkpoint") && !unknown.sent.contains("revoke"), "Unknown model issue guessed a new lease or reissued")
        cases.append("unknown_issue_retains_pending_custody_without_issue_renew_or_guessed_revoke")
        let late = try Fixture(root.appendingPathComponent("late")); let lateJob = try late.lease(); late.revokeAfterLease = true
        let revoked = try late.run(late.cleanup()); guard case .failure = revoked else { throw GuguHostFailure(code: "retirement_test_failed", message: "Revoked permit returned success") }
        try require(try late.store.record("leases", id: "issue:\(lateJob)")?["status"] as? String == "settled" && late.sent == ["checkpoint", "revoke"], "Known old lease receipt was lost or a revoked permit continued HTTP")
        late.allowed = true; late.revokeAfterLease = false; _ = try late.run(late.cleanup()).get()
        try require(late.sent.filter { $0 == "revoke" }.count == 1, "Retirement retry repeated a known lease write")
        cases.append("late_permit_revocation_preserves_known_old_lease_receipts_and_explicit_retry_skips_them")
        let conflict = try Fixture(root.appendingPathComponent("conflict")); conflict.replaceBeforePatch = true
        guard case .failure = try conflict.run(conflict.cleanup()) else { throw GuguHostFailure(code: "retirement_test_failed", message: "Replaced device CAS succeeded") }
        guard case .failure = try conflict.run(conflict.cleanup()) else { throw GuguHostFailure(code: "retirement_test_failed", message: "Retry adopted newer device registration") }
        try require(conflict.patches == 1 && (conflict.device?["capabilities"] as? [String: Any])?["replacement"] as? Bool == true, "Original cleanup withdrew a replacement device")
        cases.append("device_CAS_conflict_cannot_adopt_or_withdraw_a_new_registration")
        let lost = try Fixture(root.appendingPathComponent("lost-ACK")); lost.losePatchACK = true
        guard case .failure = try lost.run(lost.cleanup()) else { throw GuguHostFailure(code: "retirement_test_failed", message: "Lost write ACK was marked clean") }
        _ = try lost.run(lost.cleanup()).get(); try require(lost.patches == 1, "Lost device ACK caused another PATCH instead of original-version reconciliation")
        cases.append("lost_device_ACK_reconciles_original_CAS_receipt_without_a_new_PATCH")
        let checkpoint = try Fixture(root.appendingPathComponent("checkpoint")); _ = try checkpoint.lease(); checkpoint.failCheckpoint = true
        guard case .failure = try checkpoint.run(checkpoint.cleanup()) else { throw GuguHostFailure(code: "retirement_test_failed", message: "Checkpoint failure was hidden") }
        try require(checkpoint.sent.contains("revoke"), "Checkpoint failure prevented known revoke attempt")
        cases.append("checkpoint_failure_still_attempts_known_revoke_and_retains_failure")
        let switched = try Fixture(root.appendingPathComponent("old-A-current-B"))
        let newOwner = UUID().uuidString.lowercased(), newInstall = UUID().uuidString.lowercased()
        let newBinding = GuguIOSHostBinding(ownerId: newOwner, deviceId: "phone-\(newInstall)-\(newOwner)", installationId: newInstall)
        switched.publication = newBinding
        let switchedService = try switched.service(), otherJournal = try switchedService.backend.lifecycle.journal(binding: newBinding)
        let otherContext = GuguHostContext(ownerId: newOwner, installationId: newInstall, agentUserId: UUID().uuidString.lowercased(), sessionId: UUID().uuidString.lowercased(), jobId: UUID().uuidString.lowercased(), contextEpoch: UUID().uuidString.lowercased(), runtimeInstanceId: UUID().uuidString.lowercased())
        _ = try otherJournal.admit(otherContext, prompt: "Synthetic B custody", modelId: "fixture")
        let oldClean: Result<Void, Error> = try wait { switchedService.retireOwner(expectedBinding: switched.binding, retirementId: switched.retirementId, completion: $0) }; _ = try oldClean.get()
        try require(try otherJournal.job(otherContext.jobId)["status"] as? String == "running" && switched.normalCredentialCalls == 0, "Old A retirement stopped or borrowed the current B binding")
        cases.append("old_A_cleanup_while_B_is_current_preserves_B_native_context_and_uses_no_B_credentials")
        let ordinary = try Fixture(root.appendingPathComponent("ordinary")), ordinaryService = try ordinary.service()
        let catalog: Result<[[String: Any]], Error> = try wait { ordinaryService.backend.broker.catalog(binding: ordinary.binding, completion: $0) }
        guard case .failure = catalog else { throw GuguHostFailure(code: "retirement_test_failed", message: "Ordinary catalog borrowed cleanup permit") }
        let issue: Result<GuguIOSModelGrant, Error> = try wait { ordinaryService.backend.broker.issueModel(binding: ordinary.binding, agentId: UUID().uuidString.lowercased(), sessionId: UUID().uuidString.lowercased(), modelId: "fixture", recordLease: { _ in }, completion: $0) }
        guard case .failure = issue else { throw GuguHostFailure(code: "retirement_test_failed", message: "Ordinary issue borrowed cleanup permit") }
        let grant = GuguIOSModelGrant(leaseId: UUID().uuidString.lowercased(), lease: .init(ownerId: ordinary.binding.ownerId, agentUserId: UUID().uuidString.lowercased(), sessionId: UUID().uuidString.lowercased(), modelId: "fixture", completionsURL: URL(string: "https://model.invalid/v1/chat/completions")!, bearerToken: "synthetic-model-only", expiresAt: Date().addingTimeInterval(60)))
        let renewal: Result<GuguIOSModelGrant, Error> = try wait { ordinaryService.backend.broker.renewModel(binding: ordinary.binding, grant: grant, completion: $0) }
        guard case .failure = renewal else { throw GuguHostFailure(code: "retirement_test_failed", message: "Ordinary renewal borrowed cleanup permit") }
        let host: [String: Any] = try wait { ordinaryService.hostCall(["expectedBinding": ["ownerId": ordinary.binding.ownerId, "deviceId": ordinary.binding.deviceId, "installationId": ordinary.binding.installationId], "id": UUID().uuidString.lowercased(), "channel": "sessionTimeline.sessionSnapshot", "args": []], completion: $0) }
        try require(host["error"] != nil && ordinary.sent.isEmpty, "Ordinary hostCall/catalog/issue used cleanup authority")
        cases.append("ordinary_catalog_issue_renew_and_hostCall_have_no_retirement_capability_fallback")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "native_cold_retirement_APFS_and_synthetic_HTTP", "cases": cases, "realCloudHTTPCalls": 0, "realModelCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
