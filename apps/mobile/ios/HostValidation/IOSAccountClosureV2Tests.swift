#if DEBUG && os(iOS) && targetEnvironment(simulator)
import XCTest
import Security
@testable import App

/// Pure native protocol cases. Real Keychain/App integration is a separate acceptance boundary.
final class IOSAccountClosureV2Tests: XCTestCase {
    private let a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222"
    private let operationId = "55555555-5555-4555-8555-555555555555"
    private final class Memory: GuguIOSClosureSecrets {
        var values: [String: Data] = [:]
        var refuseWrite = false
        func read(_ key: String) throws -> Data? { values[key] }
        func write(_ key: String, data: Data) throws {
            if refuseWrite { throw GuguIOSClosureV2Operation.failure("closure_storage_unavailable") }; values[key] = data
        }
    }
    private final class Fixture {
        let files = Memory(), lock = NSRecursiveLock()
        var owner: String? = "11111111-1111-4111-8111-111111111111"
        var entropyCalls = 0
        let sid = "33333333-3333-4333-8333-333333333333", installation = "44444444-4444-4444-8444-444444444444"
        lazy var store = GuguIOSClosureV2Operation(secrets: files, barrier: { [unowned self] body in
            self.lock.lock(); defer { self.lock.unlock() }; try body()
        }, identity: { [unowned self] expected, _ in
            let current = self.owner ?? expected
            return .init(ownerId: current, sessionId: self.sid, installationId: self.installation,
                         deviceId: "phone-\(self.installation)-\(current)", backend: "https://fixture.invalid", authenticated: self.owner != nil)
        }, entropy: { [unowned self] in self.entropyCalls += 1; return Data(repeating: 7, count: 32) })
    }
    private func reply(_ record: GuguIOSClosureV2Record, state: String, revision: Int64, generation: Int = 0,
                       route: String = "result", status: Int = 200, extra: [String: Any] = [:]) throws -> GuguIOSClosureV2Reply {
        var op: [String: Any] = ["operation_id": operationId, "state": state, "revision": revision,
                                "challenge_generation": generation, "request_id": NSNull(), "can_retry": false]
        var body: [String: Any] = [:]
        for (key, value) in extra { if key == "preparation" || key == "error" { body[key] = value } else { op[key] = value } }
        body["operation"] = op
        return try .decode(status: status, bytes: JSONSerialization.data(withJSONObject: body), route: route)
    }
    private func registered(_ f: Fixture) throws -> GuguIOSClosureV2Record {
        let captured = try f.store.capture(ownerId: a)
        let pending = try f.store.update(captured) { $0.facts.pendingRoute = "register" }
        return try f.store.receive(pending, route: "register", backend: pending.backend, reply: reply(pending, state: "open", revision: 1, route: "register"))
    }
    func testAtomicCaptureRestoresOriginalOperationAndDoesNotReplacePendingCapability() throws {
        let f = Fixture(), captured = try f.store.capture(ownerId: a), bytes = f.files.values
        let restored = try f.store.capture(ownerId: a)
        XCTAssertEqual(captured.handle, restored.handle); XCTAssertEqual(captured.receipt.count, 32)
        XCTAssertEqual(f.files.values, bytes); XCTAssertEqual(f.entropyCalls, 1); XCTAssertEqual(bytes.count, 1)
    }
    func testFailedReplacementRetainsOldIndexAndHandle() throws {
        let f = Fixture(), captured = try f.store.capture(ownerId: a), original = f.files.values
        f.files.refuseWrite = true
        XCTAssertThrowsError(try f.store.update(captured) { $0.facts.pendingRoute = "register" })
        XCTAssertEqual(f.files.values, original)
        XCTAssertEqual(try f.store.discover(currentOwnerId: a)?.handle, captured.handle)
    }
    func testSignedOutDiscoveryOnlyRestoresOriginalScopeAndDoesNotAuthorizeNewEffects() throws {
        let f = Fixture(), captured = try f.store.capture(ownerId: a); f.owner = nil
        XCTAssertEqual(try f.store.discover(currentOwnerId: nil)?.handle, captured.handle)
        XCTAssertThrowsError(try f.store.capture(ownerId: a))
        XCTAssertThrowsError(try f.store.resolve(captured.handle, currentOwnerId: nil, recovering: false))
        XCTAssertThrowsError(try f.store.requireOpen(ownerId: a)); XCTAssertEqual(f.entropyCalls, 1)
    }
    func testBDoesNotDiscoverOrAdoptAAndItsCapturePreservesARecord() throws {
        let f = Fixture(), captured = try f.store.capture(ownerId: a); f.owner = b
        XCTAssertNil(try f.store.discover(currentOwnerId: b))
        XCTAssertThrowsError(try f.store.resolve(captured.handle, currentOwnerId: b, recovering: true))
        _ = try f.store.capture(ownerId: b)
        XCTAssertEqual(try f.store.protectedRecord(ownerId: a)?.receipt, captured.receipt)
        XCTAssertEqual(f.files.values.count, 1)
    }
    func testOnlyExactAuthoritativeUnpreparedCancelReleasesAdmission() throws {
        let f = Fixture(), original = try registered(f)
        let pending = try f.store.update(original) { $0.facts.pendingRoute = "cancel" }
        let closed = try f.store.receive(pending, route: "result", backend: pending.backend,
                                        reply: reply(pending, state: "closed_before_confirm", revision: 2))
        XCTAssertThrowsError(try f.store.requireOpen(ownerId: a)); XCTAssertFalse(closed.facts.cancelled)
        let extra: [String: Any] = ["can_release_preparation": true, "preparation": ["cancelled": true,
            "native_generation": closed.nativeGeneration, "server_generation": NSNull()]]
        let cancelled = try f.store.receive(closed, route: "result", backend: closed.backend,
            reply: reply(closed, state: "closed_before_confirm", revision: 2, extra: extra))
        XCTAssertTrue(cancelled.facts.cancelled); XCTAssertNoThrow(try f.store.requireOpen(ownerId: a))
    }
    func testOpenResultAndBare422CannotClearAnUnknownConfirmation() throws {
        let f = Fixture(), original = try registered(f)
        let pending = try f.store.update(original) { record in
            record.facts.pendingRoute = "confirm"; record.facts.confirmationId = self.b; record.facts.challengeGeneration = 1
        }
        let recovered = try f.store.receive(pending, route: "result", backend: pending.backend,
            reply: reply(pending, state: "open", revision: 2, generation: 1))
        XCTAssertEqual(recovered.facts.pendingRoute, "confirm")
        XCTAssertThrowsError(try GuguIOSClosureV2Reply.decode(status: 422, bytes: Data("{\"error\":\"verification_failed\"}".utf8), route: "confirm"))
        let exact: [String: Any] = ["confirmation": ["confirmation_id": b, "challenge_generation": 1,
            "state": "rejected", "error_code": "verification_failed"]]
        let rejected = try f.store.receive(recovered, route: "result", backend: recovered.backend,
            reply: reply(recovered, state: "open", revision: 2, generation: 1, extra: exact))
        XCTAssertTrue(rejected.facts.confirmationRejected); XCTAssertNil(rejected.facts.pendingRoute)
        XCTAssertThrowsError(try f.store.requireOpen(ownerId: a))
    }
    func testCleanupRetriesOnlyDurableRemainingStepsAndDeletedOwnerStaysBlocked() throws {
        let f = Fixture(), original = try registered(f)
        let deleted = try f.store.receive(original, route: "result", backend: original.backend,
                                         reply: reply(original, state: "deleted", revision: 2))
        let ready = try f.store.update(deleted) { $0.checkpoint = "local_prepared" }
        var steps: [Int] = []
        XCTAssertThrowsError(try f.store.cleanDeleted(ready, idle: true, erase: { step, owner in
            XCTAssertEqual(owner, self.a); if step == 2 { throw GuguIOSClosureV2Operation.failure("closure_storage_unavailable") }; steps.append(step)
        }, retained: { [] }))
        let pending = try XCTUnwrap(f.store.discover(currentOwnerId: a)); XCTAssertEqual(pending.facts.cleanupStep, 2)
        f.owner = nil
        let complete = try f.store.cleanDeleted(pending, idle: true, erase: { step, _ in steps.append(step) }, retained: { ["auth-code-verifier"] })
        let finalized = try f.store.finalize(complete)
        XCTAssertEqual(steps, [0, 1, 2, 3, 4]); XCTAssertTrue(finalized.facts.finalized)
        XCTAssertEqual(finalized.receipt, Data(repeating: 0, count: 32))
        XCTAssertThrowsError(try f.store.requireOpen(ownerId: a)); XCTAssertThrowsError(try f.store.requireAuthWrite(ownerId: a))
        XCTAssertNoThrow(try f.store.requireAuthWrite(ownerId: b))
    }
    func testUnknownConfirmCancelRetainsNonceAndMayBeRetriedAfterNoResponse() throws {
        let f = Fixture(), original = try registered(f)
        var pending = try f.store.update(original) { record in
            record.facts.pendingRoute = "confirm"; record.facts.confirmationId = self.b; record.facts.challengeGeneration = 1
        }
        pending = try f.store.update(pending) { try $0.facts.requestCancellation() }
        XCTAssertEqual(pending.facts.pendingRoute, "confirm"); XCTAssertEqual(pending.facts.confirmationId, b)
        pending = try f.store.update(pending) { try $0.facts.requestCancellation() }
        let extra: [String: Any] = ["can_release_preparation": true, "preparation": ["cancelled": true,
            "native_generation": pending.nativeGeneration, "server_generation": NSNull()]]
        let closed = try f.store.receive(pending, route: "cancel", backend: pending.backend,
            reply: reply(pending, state: "closed_before_confirm", revision: 2, generation: 1, route: "cancel", extra: extra))
        XCTAssertTrue(closed.facts.cancelled); XCTAssertFalse(closed.facts.cancelRequested)
        XCTAssertEqual(closed.facts.confirmationId, b)
    }
    func testActiveCancelBlocksAnotherDispatchAndMatchingRejectionAllowsNormalCancel() throws {
        let f = Fixture(), original = try registered(f)
        var pending = try f.store.update(original) { record in
            record.facts.pendingRoute = "confirm"; record.facts.confirmationId = self.b; record.facts.challengeGeneration = 1
            try record.facts.requestCancellation(); record.facts.confirmCancellationBlocked = true
        }
        XCTAssertThrowsError(try f.store.update(pending) { try $0.facts.requestCancellation() })
        let exact: [String: Any] = ["confirmation": ["confirmation_id": b, "challenge_generation": 1,
            "state": "rejected", "error_code": "verification_failed"]]
        pending = try f.store.receive(pending, route: "result", backend: pending.backend,
            reply: reply(pending, state: "open", revision: 2, generation: 1, extra: exact))
        XCTAssertFalse(pending.facts.confirmCancellationBlocked)
        let cancellation = try f.store.update(pending) { try $0.facts.requestCancellation() }
        XCTAssertEqual(cancellation.facts.pendingRoute, "cancel")
    }
    func testPreparedCancellationKeepsPauseUntilExplicitSameOwnerResume() throws {
        let f = Fixture(), original = try registered(f)
        let paused = try f.store.update(original) { record in
            record.checkpoint = "local_prepared"; record.facts.resumeRequired = true; try record.facts.requestCancellation()
        }
        let extra: [String: Any] = ["can_release_preparation": true, "preparation": ["cancelled": true,
            "native_generation": paused.nativeGeneration, "server_generation": NSNull()]]
        let closed = try f.store.receive(paused, route: "cancel", backend: paused.backend,
            reply: reply(paused, state: "closed_before_confirm", revision: 2, route: "cancel", extra: extra))
        XCTAssertTrue(closed.facts.resumeRequired); XCTAssertThrowsError(try f.store.requireOpen(ownerId: a))
        f.owner = b
        XCTAssertThrowsError(try f.store.resumeAfterCancellation(ownerId: a, idle: { true }))
        f.owner = a
        try f.store.resumeAfterCancellation(ownerId: a, idle: { true })
        XCTAssertNoThrow(try f.store.requireOpen(ownerId: a))
    }
    func testRealKeychainCapabilitySurvivesNativeRestartAndAuthAbsenceWithoutEnteringSnapshot() throws {
        let bundle = "app.gugu.closure-v2-test.\(UUID().uuidString.lowercased())"
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: bundle + ".account-closure"] as CFDictionary) }
        let secrets = GuguIOSClosureKeychain(bundleIdentifier: bundle), lock = NSRecursiveLock()
        var authenticated = true
        let factory = {
            GuguIOSClosureV2Operation(secrets: secrets, barrier: { body in
                lock.lock(); defer { lock.unlock() }; try body()
            }, identity: { owner, _ in
                .init(ownerId: owner, sessionId: "33333333-3333-4333-8333-333333333333",
                    installationId: "44444444-4444-4444-8444-444444444444",
                    deviceId: "phone-44444444-4444-4444-8444-444444444444-\(owner)", backend: "https://fixture.invalid", authenticated: authenticated)
            }, entropy: {
                var data = Data(count: 32)
                let status = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
                guard status == errSecSuccess else { throw GuguIOSClosureV2Operation.failure("closure_storage_unavailable") }
                return data
            })
        }
        let original = factory(), captured = try original.capture(ownerId: a)
        let receipt = try original.nativeReceipt(captured, recovering: false)
        XCTAssertEqual(receipt.count, 64)
        let exposed = try JSONSerialization.data(withJSONObject: GuguIOSClosureV2Facade.snapshot(captured))
        XCTAssertFalse(String(decoding: exposed, as: UTF8.self).contains(receipt))
        authenticated = false
        let restarted = factory(), recovered = try XCTUnwrap(restarted.discover(currentOwnerId: nil))
        XCTAssertEqual(recovered.handle, captured.handle)
        XCTAssertEqual(try restarted.nativeReceipt(recovered, recovering: true), receipt)
        XCTAssertThrowsError(try restarted.capture(ownerId: a))
    }
    func testRealAuthRetirementKeepsExplicitEmptyEnvelopeAndPreservesCurrentBBytes() throws {
        let bundle = "app.gugu.closure-v2-auth-test.\(UUID().uuidString.lowercased())"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: bundle + ".auth-storage", kSecAttrAccount as String: "sb-main"]
        defer { SecItemDelete(query as CFDictionary) }
        func envelope(_ owner: String) throws -> Data {
            let raw = try JSONSerialization.data(withJSONObject: ["user": ["id": owner]])
            return try JSONSerialization.data(withJSONObject: ["state": "SESSION", "raw": String(decoding: raw, as: UTF8.self)])
        }
        func read() throws -> Data {
            var request = query; request[kSecReturnData as String] = true
            var value: CFTypeRef?; XCTAssertEqual(SecItemCopyMatching(request as CFDictionary, &value), errSecSuccess)
            return try XCTUnwrap(value as? Data)
        }
        var add = query; add[kSecValueData as String] = try envelope(a)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)
        let slot = GuguIOSClosureAuthSlot(bundleIdentifier: bundle)
        try slot.retireMainIfOwned(by: a)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: read()) as? [String: String], ["state": "RETIRED_EMPTY"])
        let bBytes = try envelope(b)
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, [kSecValueData as String: bBytes] as CFDictionary), errSecSuccess)
        try slot.retireMainIfOwned(by: a)
        XCTAssertEqual(try read(), bBytes)
    }
}
#endif
