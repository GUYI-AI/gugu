import Foundation
import Testing
@testable import GuguPushNotifications

private let ownerA = "11111111-1111-4111-8111-111111111111"
private let ownerB = "22222222-2222-4222-8222-222222222222"
private let install = "33333333-3333-4333-8333-333333333333"
private func binding(_ owner: String = ownerA, _ installation: String = install) -> GuguPushBinding {
    .init(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
}
private func pushSettings(_ authorization: GuguPushAuthorization = .authorized, alert: GuguPushSetting = .enabled) -> GuguPushSettings {
    .init(authorization: authorization, alert: alert, sound: .enabled, badge: .disabled,
          notificationCenter: .enabled, lockScreen: .enabled)
}

@MainActor private final class Platform: GuguPushPlatform {
    var value = pushSettings()
    var reads = 0, requests = 0, tokenRequests = 0, unregisters = 0, clears = 0
    var registrationPending = false
    var delayToken = false, delayPermission = false
    var tokenGate: CheckedContinuation<Data, Error>?
    var permissionGate: CheckedContinuation<Void, Error>?
    var token = Data([1, 2, 3, 4, 5])
    var nextPermission = pushSettings()
    func settings() async -> GuguPushSettings { reads += 1; return value }
    func requestAuthorization(check: @escaping () throws -> Void) async throws {
        try check(); requests += 1
        if delayPermission { try await withCheckedThrowingContinuation { permissionGate = $0 } }
        else { value = nextPermission }
    }
    func deviceToken(ticket: GuguPushTicket, check: @escaping () throws -> Void) async throws -> Data {
        try check()
        guard !registrationPending else { throw GuguPushFailure.busy }
        tokenRequests += 1; registrationPending = true
        defer { registrationPending = false }
        if delayToken { return try await withCheckedThrowingContinuation { tokenGate = $0 } }
        return token
    }
    func unregister() { unregisters += 1 }
    func clearDelivered() { clears += 1 }
}

@MainActor private final class Provider: GuguPushProvider {
    var registrations: [GuguPushTicket] = [], revocations: [GuguPushRevocationRequest] = []
    var delayRegister = false, delayRevoke = false, failRegister = false, failRevoke = false
    var registerGate: CheckedContinuation<GuguPushRegistrationReceipt, Error>?
    var revokeGate: CheckedContinuation<Bool, Error>?
    var replaceAck: GuguPushRegistrationReceipt?
    var revokeValue = true
    var cancelAfterRevoke = false
    var receipts: [UUID: GuguPushRegistrationReceipt] = [:]
    func register(_ request: GuguPushRegistrationRequest) async throws -> GuguPushRegistrationReceipt {
        registrations.append(request.ticket)
        #expect(request.withDeviceToken { !$0.isEmpty })
        #expect(String(reflecting: request) == "APNs registration request (token redacted)")
        #expect(request.customMirror.children.isEmpty)
        if failRegister { throw NSError(domain: "raw secret must not escape", code: 1) }
        if delayRegister { return try await withCheckedThrowingContinuation { registerGate = $0 } }
        return replaceAck ?? receipt(request.ticket)
    }
    func revoke(_ request: GuguPushRevocationRequest) async throws -> Bool {
        revocations.append(request)
        if failRevoke { throw NSError(domain: "raw secret must not escape", code: 1) }
        if delayRevoke { return try await withCheckedThrowingContinuation { revokeGate = $0 } }
        if cancelAfterRevoke { withUnsafeCurrentTask { $0?.cancel() } }
        return revokeValue
    }
    func receipt(_ ticket: GuguPushTicket) -> GuguPushRegistrationReceipt {
        if let saved = receipts[ticket.generation] { return saved }
        let value = GuguPushRegistrationReceipt(ticket: ticket, registrationId: UUID().uuidString.lowercased(),
            serverGeneration: UUID(), preferences: .init(chatEnabled: true, taskEnabled: true, soundEnabled: false))
        receipts[ticket.generation] = value; return value
    }
}

@MainActor private final class Fixture {
    let platform = Platform(), provider = Provider()
    var current = binding(), foreground = true
    var preferences = GuguPushPreferences(chatEnabled: true, taskEnabled: true, soundEnabled: false)
    var present = true
    var duringPresentation: (() -> Void)?
    var hints: [GuguPushReconciliationHint] = []
    lazy var client = make(provider: provider)
    func make(provider: Provider?) -> GuguPushClient {
        GuguPushClient(platform: platform, provider: provider, currentBinding: { self.current }, requireOwnerUI: {
            guard self.foreground else { throw GuguPushFailure(code: "not_granted", message: "Foreground owner UI is required") }
        }, preferences: { self.preferences }, foregroundPresentation: { _ in self.duringPresentation?(); return self.present }, onHint: { self.hints.append($0) })
    }
    func envelope() -> GuguPushEnvelope {
        let r = provider.receipt(provider.registrations.last!)
        return .init(binding: r.ticket.binding, registrationId: r.registrationId, serverGeneration: r.serverGeneration,
                     eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: .chatMessage, revision: "1")
    }
}

@MainActor private func code(_ operation: () async throws -> Void) async -> String {
    do { try await operation(); return "success" }
    catch let failure as GuguPushFailure { return failure.code }
    catch { return "unexpected" }
}
@MainActor private func waitUntil(_ predicate: () -> Bool) async {
    for _ in 0..<1000 { if predicate() { return }; await Task.yield() }
    Issue.record("Expected async boundary was not reached")
}

@Suite @MainActor struct GuguPushClientTests {
    @Test func discoveryReadsTruthWithoutPromptOrRegistration() async throws {
        let f = Fixture(); f.platform.value = pushSettings(.provisional)
        let state = try await f.client.status(expectedBinding: f.current)
        #expect(state.settings.authorization == .provisional)
        #expect(!state.settings.visibleAlertsAllowed && !state.serverRegistered)
        #expect(f.platform.requests == 0 && f.platform.tokenRequests == 0 && f.provider.registrations.isEmpty)
        #expect(!state.json.keys.contains("token") && !state.json.keys.contains("deviceToken"))
    }

    @Test(arguments: ["owner", "installation", "device"]) func staleCallerHasZeroOSOrProviderEffects(field: String) async {
        let f = Fixture()
        let old: GuguPushBinding
        switch field {
        case "owner": old = binding(ownerB)
        case "installation": old = binding(ownerA, "44444444-4444-4444-8444-444444444444")
        default: old = .init(ownerId: ownerA, deviceId: UUID().uuidString.lowercased(), installationId: install)
        }
        #expect(await code { _ = try await f.client.status(expectedBinding: old) } == "stale_context")
        #expect(await code { _ = try await f.client.requestAuthorization(expectedBinding: old) } == "stale_context")
        #expect(await code { _ = try await f.client.register(expectedBinding: old) } == "stale_context")
        #expect(await code { _ = try await f.client.revoke(expectedBinding: old) } == "stale_context")
        #expect(f.platform.reads == 0 && f.platform.requests == 0 && f.platform.unregisters == 0)
        #expect(f.provider.registrations.isEmpty && f.provider.revocations.isEmpty)
    }

    @Test func permissionRequiresForegroundAndNeverRegistersImplicitly() async throws {
        let f = Fixture(); f.platform.value = pushSettings(.notDetermined); f.foreground = false
        #expect(await code { _ = try await f.client.requestAuthorization(expectedBinding: f.current) } == "not_granted")
        #expect(f.platform.requests == 0)
        f.foreground = true
        let state = try await f.client.requestAuthorization(expectedBinding: f.current)
        #expect(state.settings.authorization == .authorized && !state.serverRegistered)
        #expect(f.platform.requests == 1 && f.platform.tokenRequests == 0)
    }

    @Test func deniedPermissionDoesNotReprompt() async throws {
        let f = Fixture(); f.platform.value = pushSettings(.denied)
        let state = try await f.client.requestAuthorization(expectedBinding: f.current)
        #expect(state.settings.authorization == .denied && f.platform.requests == 0)
    }

    @Test func latePermissionReplyCannotPublishForNewOwner() async {
        let f = Fixture(); f.platform.value = pushSettings(.notDetermined); f.platform.delayPermission = true
        let old = f.current
        let task = Task { await code { _ = try await f.client.requestAuthorization(expectedBinding: old) } }
        await waitUntil { f.platform.permissionGate != nil }
        f.current = binding(ownerB); f.client.invalidate(); f.platform.value = pushSettings()
        f.platform.permissionGate?.resume(); f.platform.permissionGate = nil
        #expect(await task.value == "stale_context")
        #expect(f.platform.tokenRequests == 0 && f.provider.registrations.isEmpty)
    }

    @Test func missingProviderNeverClaimsRegistrationOrRequestsToken() async {
        let f = Fixture(); let client = f.make(provider: nil)
        #expect(await code { _ = try await client.register(expectedBinding: f.current) } == "backend_unavailable")
        #expect(f.platform.tokenRequests == 0)
    }

    @Test(arguments: [GuguPushAuthorization.denied, .notDetermined, .provisional, .unknown])
    func insufficientVisiblePermissionBlocksRegistration(authorization: GuguPushAuthorization) async {
        let f = Fixture(); f.platform.value = pushSettings(authorization)
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "os_permission")
        #expect(f.platform.requests == 0 && f.platform.tokenRequests == 0 && f.provider.registrations.isEmpty)
    }

    @Test func authorizedButAlertsDisabledIsNotVisibleReady() async {
        let f = Fixture(); f.platform.value = pushSettings(.authorized, alert: .disabled)
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "os_permission")
        #expect(f.platform.tokenRequests == 0)
    }

    @Test func tokenAloneRemainsUnregisteredUntilMatchingAck() async throws {
        let f = Fixture(); f.provider.delayRegister = true
        let task = Task { try await f.client.register(expectedBinding: f.current) }
        await waitUntil { f.provider.registerGate != nil }
        let pending = try await f.client.status(expectedBinding: f.current)
        #expect(pending.phase == .registering && !pending.serverRegistered)
        let ticket = f.provider.registrations[0]
        f.provider.registerGate?.resume(returning: f.provider.receipt(ticket)); f.provider.registerGate = nil
        let done = try await task.value
        #expect(done.phase == .registered && done.serverRegistered)
    }

    @Test func concurrentAPNsRequestIsRejected() async {
        let f = Fixture(); f.platform.delayToken = true
        let task = Task { await code { _ = try await f.client.register(expectedBinding: f.current) } }
        await waitUntil { f.platform.tokenGate != nil }
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "registration_pending")
        #expect(f.platform.tokenRequests == 1)
        f.platform.tokenGate?.resume(returning: Data([8])); f.platform.tokenGate = nil
        #expect(await task.value == "success")
    }

    @Test func oldTokenDrainsBeforeNewOwnerAndNeverRebinds() async {
        let f = Fixture(); f.platform.delayToken = true; let old = f.current
        let task = Task { await code { _ = try await f.client.register(expectedBinding: old) } }
        await waitUntil { f.platform.tokenGate != nil }
        f.current = binding(ownerB); f.client.invalidate()
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "registration_pending")
        f.platform.tokenGate?.resume(returning: Data([9])); f.platform.tokenGate = nil
        #expect(await task.value == "stale_context")
        #expect(f.provider.registrations.isEmpty)
    }

    @Test func lateServerAckCannotRestoreRetiredGeneration() async throws {
        let f = Fixture(); f.provider.delayRegister = true; let old = f.current
        let task = Task { await code { _ = try await f.client.register(expectedBinding: old) } }
        await waitUntil { f.provider.registerGate != nil }
        let ticket = f.provider.registrations[0]
        f.client.invalidate()
        f.provider.registerGate?.resume(returning: f.provider.receipt(ticket)); f.provider.registerGate = nil
        #expect(await task.value == "stale_context")
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
    }

    @Test func mismatchedAckIsRejected() async {
        let f = Fixture()
        f.provider.replaceAck = .init(ticket: .init(binding: binding(ownerB), generation: UUID()), registrationId: UUID().uuidString.lowercased(), serverGeneration: UUID(), preferences: f.preferences)
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "registration_unknown")
    }

    @Test func serverFailureStaysUnknownAndSanitized() async throws {
        let f = Fixture(); f.provider.failRegister = true
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "registration_unknown")
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
    }

    @Test func permissionLossWithdrawsAckAndRegrantDoesNotRevive() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let envelope = f.envelope(); f.platform.value = pushSettings(.denied)
        let denied = try await f.client.status(expectedBinding: f.current)
        #expect(denied.phase == .blocked && !denied.serverRegistered)
        f.platform.value = pushSettings()
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
        #expect(await !f.client.handle(envelope, kind: .opened) && f.hints.isEmpty)
    }

    @Test func registrationPermissionRecheckedAfterServerAck() async {
        let f = Fixture(); f.provider.delayRegister = true
        let task = Task { await code { _ = try await f.client.register(expectedBinding: f.current) } }
        await waitUntil { f.provider.registerGate != nil }
        f.platform.value = pushSettings(.denied)
        f.provider.registerGate?.resume(returning: f.provider.receipt(f.provider.registrations[0])); f.provider.registerGate = nil
        #expect(await task.value == "os_permission")
    }

    @Test func duplicateReceiptAndTapAreIndependentlyBoundedHints() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let envelope = f.envelope()
        #expect(await f.client.handle(envelope, kind: .received))
        #expect(await !f.client.handle(envelope, kind: .received))
        #expect(await f.client.handle(envelope, kind: .opened))
        #expect(await !f.client.handle(envelope, kind: .opened))
        #expect(f.hints.count == 2)
    }

    @Test(arguments: ["owner", "installation", "registration", "generation", "empty", "oversize"])
    func malformedOrStaleNotificationHasNoHint(field: String) async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let valid = f.envelope(); var scope = valid.binding
        var generation = valid.serverGeneration
        if field == "owner" { scope = binding(ownerB) }
        if field == "installation" { scope = binding(ownerA, UUID().uuidString.lowercased()) }
        if field == "generation" { generation = UUID() }
        let event = field == "empty" ? "" : field == "oversize" ? String(repeating: "x", count: 257) : valid.eventId
        let envelope = GuguPushEnvelope(binding: scope, registrationId: field == "registration" ? "other" : valid.registrationId,
            serverGeneration: generation, eventId: event, kind: valid.kind, revision: valid.revision)
        #expect(await !f.client.handle(envelope, kind: .opened))
        #expect(f.hints.isEmpty)
    }

    @Test func coldProcessHasNoAuthorityFromOldPayload() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let cold = f.make(provider: f.provider)
        #expect(await !cold.handle(f.envelope(), kind: .opened))
        #expect(try await !cold.status(expectedBinding: f.current).serverRegistered)
    }

    @Test func revokeWithdrawsBeforeAckAndRetainsScopeOnFailure() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let envelope = f.envelope(); f.provider.failRevoke = true
        #expect(await code { _ = try await f.client.revoke(expectedBinding: f.current) } == "revocation_unknown")
        #expect(await !f.client.handle(envelope, kind: .opened))
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
        let first = f.provider.revocations[0]
        f.provider.failRevoke = false
        let state = try await f.client.revoke(expectedBinding: f.current)
        #expect(state.phase == .revoked && !state.serverRegistered)
        #expect(f.provider.revocations.last?.ticket == first.ticket)
    }

    @Test func cancellationBeforeTokenReturnPreventsProviderWrite() async {
        let f = Fixture(); f.platform.delayToken = true
        let task = Task { await code { _ = try await f.client.register(expectedBinding: f.current) } }
        await waitUntil { f.platform.tokenGate != nil }; task.cancel()
        f.platform.tokenGate?.resume(returning: Data([1])); f.platform.tokenGate = nil
        #expect(await task.value == "cancelled")
        #expect(f.provider.registrations.isEmpty)
    }

    @Test func oldAckRemainsCleanupAndCannotAuthorizeNewOwner() async throws {
        let f = Fixture(); f.provider.delayRegister = true; let old = f.current
        let task = Task { await code { _ = try await f.client.register(expectedBinding: old) } }
        await waitUntil { f.provider.registerGate != nil }
        let oldGate = f.provider.registerGate!, oldTicket = f.provider.registrations[0]
        f.provider.registerGate = nil; f.provider.delayRegister = false
        f.current = binding(ownerB); f.client.invalidate()
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "registration_pending")
        oldGate.resume(returning: f.provider.receipt(oldTicket))
        #expect(await task.value == "stale_context")
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "revocation_unknown")
    }

    @Test func staleStatusCannotObserveAndRevokeNewOwner() async throws {
        let f = Fixture(); let old = f.current
        f.current = binding(ownerB)
        _ = try await f.client.register(expectedBinding: f.current)
        f.platform.value = pushSettings(.denied)
        let before = f.platform.reads
        #expect(await code { _ = try await f.client.status(expectedBinding: old) } == "stale_context")
        #expect(f.platform.reads == before)
        f.platform.value = pushSettings()
        #expect(try await f.client.status(expectedBinding: f.current).serverRegistered)
    }

    @Test func observedOSRevocationPreservesServerCleanupScope() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let ticket = f.provider.registrations[0]
        f.platform.value = pushSettings(.denied)
        _ = try await f.client.status(expectedBinding: f.current)
        _ = try await f.client.status(expectedBinding: f.current)
        let state = try await f.client.revoke(expectedBinding: f.current)
        #expect(state.phase == .revoked)
        #expect(f.provider.revocations[0].ticket == ticket)
        #expect(UUID(uuidString: f.provider.revocations[0].registrationId) != nil)
    }

    @Test func revokeIsLocallyEffectiveBeforeServerReply() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let envelope = f.envelope(); f.provider.delayRevoke = true
        let task = Task { try await f.client.revoke(expectedBinding: f.current) }
        await waitUntil { f.provider.revokeGate != nil }
        let state = try await f.client.status(expectedBinding: f.current)
        #expect(state.phase == .revoking && !state.serverRegistered)
        #expect(await !f.client.handle(envelope, kind: .opened))
        f.provider.revokeGate?.resume(returning: true); f.provider.revokeGate = nil
        #expect(try await task.value.phase == .revoked)
    }

    @Test(arguments: [0, 2049]) func invalidTokenNeverReachesProvider(length: Int) async {
        let f = Fixture(); f.platform.token = Data(repeating: 1, count: length)
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "registration_failed")
        #expect(f.provider.registrations.isEmpty)
    }

    @Test func unknownRegistrationCannotBeReportedRevoked() async {
        let f = Fixture()
        #expect(await code { _ = try await f.client.revoke(expectedBinding: f.current) } == "revocation_unknown")
        #expect(f.provider.revocations.isEmpty)
    }

    @Test func retirementWaitsForLateAckThenRevokesExactServerGeneration() async throws {
        let f = Fixture(); f.provider.delayRegister = true
        let register = Task { await code { _ = try await f.client.register(expectedBinding: f.current) } }
        await waitUntil { f.provider.registerGate != nil }
        let ticket = f.provider.registrations[0], ack = f.provider.receipt(f.provider.registrations[0])
        #expect(ack.serverGeneration != ticket.generation)
        let retirement = Task { try await f.client.retire(expectedBinding: f.current) }
        await waitUntil { f.platform.unregisters == 1 }
        #expect(f.provider.revocations.isEmpty && f.platform.clears == 1)
        f.provider.registerGate?.resume(returning: ack); f.provider.registerGate = nil
        #expect(await register.value == "stale_context")
        try await retirement.value
        #expect(f.provider.revocations.count == 1)
        #expect(f.provider.revocations[0].receipt == ack)
        #expect(try await f.client.status(expectedBinding: f.current).phase == .revoked)
        // Both readers of the same register task have now finished. Re-reading
        // retirement must not reinsert/revoke the already-removed receipt.
        f.provider.revokeValue = false
        try await f.client.retire(expectedBinding: f.current)
        #expect(f.provider.revocations.count == 1)
    }

    @Test func falseRevokeNeverReleasesRetirementBarrier() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        f.provider.revokeValue = false
        #expect(await code { try await f.client.retire(expectedBinding: f.current) } == "revocation_unknown")
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
        f.provider.revokeValue = true
        try await f.client.retire(expectedBinding: f.current)
        #expect(f.provider.revocations.count == 2)
        #expect(f.provider.revocations[0].receipt == f.provider.revocations[1].receipt)
    }

    @Test func unknownRegisterRequiresExplicitRecoveryBeforeRetirement() async throws {
        let f = Fixture(); f.provider.failRegister = true
        #expect(await code { _ = try await f.client.register(expectedBinding: f.current) } == "registration_unknown")
        #expect(await code { try await f.client.retire(expectedBinding: f.current) } == "revocation_unknown")
        #expect(f.provider.revocations.isEmpty && f.provider.registrations.count == 1)
        f.provider.failRegister = false
        try await f.client.resolveUncertainRegistration(expectedBinding: f.current)
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
        #expect(f.provider.registrations[0] == f.provider.registrations[1])
        try await f.client.retire(expectedBinding: f.current)
        #expect(f.provider.revocations.count == 1)
    }

    @Test func foregroundPolicyAndSoundPreferenceAreIndependentFromHints() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let envelope = f.envelope()
        #expect(await f.client.handle(envelope, kind: .received))
        #expect(f.client.presentation(for: envelope) == .alert)
        f.present = false
        #expect(f.client.presentation(for: envelope) == .none)
        #expect(f.hints.count == 1)
        f.preferences = .init(chatEnabled: false, taskEnabled: true, soundEnabled: false)
        #expect(await !f.client.handle(envelope, kind: .opened))
        #expect(try await !f.client.status(expectedBinding: f.current).serverRegistered)
    }

    @Test func trueRevokeReceiptSurvivesCallerCancellationWithoutSecondWrite() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        f.provider.cancelAfterRevoke = true
        let task = Task { await code { try await f.client.retire(expectedBinding: f.current) } }
        #expect(await task.value == "cancelled")
        #expect(f.provider.revocations.count == 1)
        f.provider.cancelAfterRevoke = false
        try await f.client.retire(expectedBinding: f.current)
        #expect(f.provider.revocations.count == 1)
    }

    @Test func foregroundPolicyCannotCarryOldOwnerAcrossItsOwnCallback() async throws {
        let f = Fixture(); _ = try await f.client.register(expectedBinding: f.current)
        let envelope = f.envelope()
        f.duringPresentation = { f.current = binding(ownerB) }
        #expect(f.client.presentation(for: envelope) == .none)
    }
}
