import Foundation

/// App-lifetime custody. Epoch is local; registration generation comes from RPC.
@MainActor final class GuguPushClient {
    private let platform: GuguPushPlatform
    private let provider: GuguPushProvider?
    private let currentBinding: () throws -> GuguPushBinding
    private let requireOwnerUI: () throws -> Void
    private let preferences: () -> GuguPushPreferences
    private let foregroundPresentation: (GuguPushEnvelope) -> Bool
    private let onHint: (GuguPushReconciliationHint) -> Void
    private var generation = UUID()
    private var receipt: GuguPushRegistrationReceipt?
    private var activeBinding: GuguPushBinding?
    private var phase: GuguPushPhase = .none
    private var rpc: (request: GuguPushRegistrationRequest, task: Task<GuguPushRegistrationReceipt, Error>)?
    private var uncertain: GuguPushRegistrationRequest?
    private var known: [String: GuguPushRegistrationReceipt] = [:]
    private var settled: [UUID: GuguPushRegistrationReceipt] = [:]
    private var retiring = false
    private var cleanBindings: [GuguPushBinding] = []
    private var seen: Set<String> = []
    private var seenOrder: [String] = []

    init(platform: GuguPushPlatform, provider: GuguPushProvider?,
         currentBinding: @escaping () throws -> GuguPushBinding,
         requireOwnerUI: @escaping () throws -> Void,
         preferences: @escaping () -> GuguPushPreferences,
         foregroundPresentation: @escaping (GuguPushEnvelope) -> Bool,
         onHint: @escaping (GuguPushReconciliationHint) -> Void) {
        self.platform = platform; self.provider = provider
        self.currentBinding = currentBinding; self.requireOwnerUI = requireOwnerUI
        self.preferences = preferences; self.foregroundPresentation = foregroundPresentation; self.onHint = onHint
    }

    func status(expectedBinding: GuguPushBinding) async throws -> GuguPushSnapshot {
        try check(expectedBinding)
        let epoch = generation
        let settings = await platform.settings()
        try check(expectedBinding, generation: epoch)
        if activeBinding == expectedBinding, [.registered, .awaitingAPNs, .registering].contains(phase),
           (!settings.visibleAlertsAllowed || receipt.map({ $0.preferences != preferences() }) == true) {
            invalidate(); activeBinding = expectedBinding; phase = .blocked
        }
        return snapshot(settings, binding: expectedBinding)
    }

    func requestAuthorization(expectedBinding: GuguPushBinding) async throws -> GuguPushSnapshot {
        try check(expectedBinding, ownerUI: true)
        let epoch = generation
        let before = await platform.settings()
        try check(expectedBinding, generation: epoch, ownerUI: true)
        if before.authorization == .notDetermined {
            do {
                try await platform.requestAuthorization {
                    try self.check(expectedBinding, generation: epoch, ownerUI: true)
                }
            } catch let error as GuguPushFailure { throw error }
            catch { throw GuguPushFailure.permission }
        }
        try check(expectedBinding, generation: epoch)
        return try await status(expectedBinding: expectedBinding)
    }

    func register(expectedBinding: GuguPushBinding) async throws -> GuguPushSnapshot {
        try check(expectedBinding, ownerUI: true)
        guard let provider else { throw GuguPushFailure.unavailable }
        try requireRegistrationIdle(expectedBinding)
        let previous = generation
        let settings = await platform.settings()
        try check(expectedBinding, generation: previous, ownerUI: true)
        try requireRegistrationIdle(expectedBinding)
        guard settings.visibleAlertsAllowed else { throw GuguPushFailure.permission }
        invalidate(); activeBinding = expectedBinding; phase = .awaitingAPNs
        let ticket = GuguPushTicket(binding: expectedBinding, generation: generation)
        let selected = preferences()
        do {
            let token = try await platform.deviceToken(ticket: ticket) {
                try self.check(expectedBinding, generation: ticket.generation, ownerUI: true)
            }
            try check(expectedBinding, generation: ticket.generation)
            // Server limit is 4096 hexadecimal characters, not 4096 bytes.
            guard !token.isEmpty, token.count <= 2048 else {
                throw GuguPushFailure(code: "registration_failed", message: "APNs did not return a valid token")
            }
            let current = await platform.settings()
            try check(expectedBinding, generation: ticket.generation)
            guard current.visibleAlertsAllowed else { throw GuguPushFailure.permission }
            guard selected == preferences() else { throw GuguPushFailure.stale }
            phase = .registering
            cleanBindings.removeAll { $0 == expectedBinding }
            let request = GuguPushRegistrationRequest(ticket: ticket, preferences: selected, deviceToken: token)
            let task = Task { try await provider.register(request) }
            rpc = (request, task)
            let ack: GuguPushRegistrationReceipt
            do { ack = try await task.value }
            catch {
                // Preserve unknown write scope and memory-only token for an
                // explicit idempotent recovery, never an automatic replay.
                uncertain = request
                if rpc?.request.ticket == ticket { rpc = nil }
                throw GuguPushFailure(code: "registration_unknown", message: "Notification registration was not confirmed; resolve before signing out")
            }
            // Book known side effects BEFORE cancellation/retirement rejection.
            do { try remember(ack, request: request) }
            catch {
                uncertain = request
                if rpc?.request.ticket == ticket { rpc = nil }
                throw GuguPushFailure(code: "registration_unknown", message: "Notification registration acknowledgement was not confirmed")
            }
            if rpc?.request.ticket == ticket { rpc = nil }
            try check(expectedBinding, generation: ticket.generation)
            guard selected == preferences() else { throw GuguPushFailure.stale }
            let finalSettings = await platform.settings()
            try check(expectedBinding, generation: ticket.generation)
            guard finalSettings.visibleAlertsAllowed else { throw GuguPushFailure.permission }
            receipt = ack; phase = .registered
            return snapshot(finalSettings, binding: expectedBinding)
        } catch {
            if generation == ticket.generation { receipt = nil; phase = .failed }
            if let error = error as? GuguPushFailure { throw error }
            throw GuguPushFailure(code: "registration_unknown", message: "Notification registration was not confirmed")
        }
    }

    /// Explicit recovery of a prior unknown idempotent register. It only saves
    /// cleanup metadata, never publishes registration authority or reuses it as
    /// a new owner/session. Call before credential retirement when requested.
    func resolveUncertainRegistration(expectedBinding: GuguPushBinding) async throws {
        try check(expectedBinding, ownerUI: true)
        guard !retiring, rpc == nil, let request = uncertain,
              request.ticket.binding == expectedBinding, let provider else { throw GuguPushFailure.unavailable }
        let task = Task { try await provider.register(request) }
        rpc = (request, task)
        do {
            let ack = try await task.value
            try remember(ack, request: request)
            if rpc?.request.ticket == request.ticket { rpc = nil }
            if uncertain?.ticket == request.ticket { uncertain = nil }
            try check(expectedBinding)
        } catch {
            if rpc?.request.ticket == request.ticket { rpc = nil }
            if let failure = error as? GuguPushFailure { throw failure }
            throw GuguPushFailure(code: "registration_unknown", message: "Notification registration recovery was not confirmed")
        }
    }

    func revoke(expectedBinding: GuguPushBinding) async throws -> GuguPushSnapshot {
        try check(expectedBinding, ownerUI: true)
        try await retire(expectedBinding: expectedBinding)
        return try await status(expectedBinding: expectedBinding)
    }

    /// Native credential-write barrier: caller retains an explicit revocation
    /// credential capability until this finishes. It must not bypass OwnerSession.
    func retire(expectedBinding: GuguPushBinding) async throws {
        try check(expectedBinding)
        guard !retiring else { throw GuguPushFailure.busy }
        let pending = rpc
        invalidate(); activeBinding = expectedBinding; phase = .revoking; retiring = true
        platform.unregister(); platform.clearDelivered()
        let epoch = generation
        defer { retiring = false }
        do {
            guard let provider else { throw GuguPushFailure.unavailable }
            if let pending {
                do {
                    let ack = try await pending.task.value
                    try remember(ack, request: pending.request)
                    if uncertain?.ticket == pending.request.ticket { uncertain = nil }
                } catch {
                    throw GuguPushFailure(code: "revocation_unknown", message: "Pending notification registration must be resolved before signing out")
                }
            }
            try check(expectedBinding, generation: epoch)
            guard uncertain == nil else {
                throw GuguPushFailure(code: "revocation_unknown", message: "Unknown notification registration must be resolved before signing out")
            }
            let targets = known.values.filter { $0.ticket.binding == expectedBinding }
            guard !targets.isEmpty || cleanBindings.contains(expectedBinding) else {
                throw GuguPushFailure(code: "revocation_unknown", message: "No server registration scope is known; reconcile before signing out")
            }
            for target in targets {
                try check(expectedBinding, generation: epoch)
                let removed = try await provider.revoke(.init(receipt: target))
                // Keep the true server receipt even if cancellation/account
                // retirement wins before the caller receives completion.
                if removed, known[target.registrationId] == target { known.removeValue(forKey: target.registrationId) }
                guard removed else {
                    throw GuguPushFailure(code: "revocation_unknown", message: "The exact server notification registration was not removed")
                }
            }
            if !cleanBindings.contains(expectedBinding) { cleanBindings.append(expectedBinding) }
            try check(expectedBinding, generation: epoch)
            phase = .revoked
        } catch {
            if generation == epoch { phase = .failed }
            if let failure = error as? GuguPushFailure { throw failure }
            throw GuguPushFailure(code: "revocation_unknown", message: "Server notification revocation was not confirmed")
        }
    }

    /// Local withdrawal only. Known/pending writes survive for exact cleanup.
    func invalidate() {
        generation = UUID(); receipt = nil; activeBinding = nil; phase = .none
        seen.removeAll(); seenOrder.removeAll()
    }

    func handle(_ envelope: GuguPushEnvelope, kind: GuguPushEventKind) async -> Bool {
        do {
            let epoch = generation
            try check(envelope.binding, generation: epoch)
            guard matches(envelope) else { return false }
            let settings = await platform.settings()
            try check(envelope.binding, generation: epoch)
            guard settings.visibleAlertsAllowed else { invalidate(); return false }
            guard matches(envelope), UUID(uuidString: envelope.eventId)?.uuidString.lowercased() == envelope.eventId,
                  GuguPushPayload.validRevision(envelope.revision), let receipt else { return false }
            let key = kind.rawValue + ":" + envelope.eventId
            guard seen.insert(key).inserted else { return false }
            seenOrder.append(key)
            if seenOrder.count > 512 { seen.remove(seenOrder.removeFirst()) }
            onHint(.init(receipt: receipt, eventId: envelope.eventId, kind: kind,
                         notificationKind: envelope.kind, revision: envelope.revision))
            return true
        } catch { return false }
    }

    func presentation(for envelope: GuguPushEnvelope) -> GuguPushPresentation {
        guard (try? check(envelope.binding)) != nil, matches(envelope), foregroundPresentation(envelope), let receipt else { return .none }
        // An injected foreground policy cannot make an earlier binding check
        // authorize an account transition performed while it was consulted.
        guard (try? check(envelope.binding)) != nil, matches(envelope) else { return .none }
        return receipt.preferences.soundEnabled ? .alertWithSound : .alert
    }

    private func matches(_ envelope: GuguPushEnvelope) -> Bool {
        phase == .registered && receipt?.ticket.binding == envelope.binding && receipt?.registrationId == envelope.registrationId &&
        receipt?.serverGeneration == envelope.serverGeneration && receipt?.preferences == preferences() &&
        receipt?.preferences.allows(envelope.kind) == true
    }
    private func remember(_ ack: GuguPushRegistrationReceipt, request: GuguPushRegistrationRequest) throws {
        try ack.validate()
        guard ack.ticket == request.ticket, ack.preferences == request.preferences else { throw GuguPushFailure.stale }
        // Both the original register caller and a retirement barrier may await
        // one RPC. A later reader must not reinsert an already-revoked receipt.
        if let prior = settled[request.ticket.generation] {
            guard prior == ack else { throw GuguPushFailure.stale }
            return
        }
        settled[request.ticket.generation] = ack
        known[ack.registrationId] = ack
        cleanBindings.removeAll { $0 == ack.ticket.binding }
    }
    private func requireRegistrationIdle(_ binding: GuguPushBinding) throws {
        guard !retiring, rpc == nil, uncertain == nil, phase != .awaitingAPNs,
              !platform.registrationPending else { throw GuguPushFailure.busy }
        guard known.values.allSatisfy({ $0.ticket.binding == binding }) else {
            throw GuguPushFailure(code: "revocation_unknown", message: "Previous owner notification registration must be retired first")
        }
    }
    private func check(_ binding: GuguPushBinding, generation expected: UUID? = nil, ownerUI: Bool = false) throws {
        guard !Task.isCancelled else { throw GuguPushFailure(code: "cancelled", message: "Notification operation was cancelled") }
        try binding.validate()
        let current: GuguPushBinding
        do { current = try currentBinding() }
        catch let failure as GuguPushFailure { throw failure }
        catch { throw GuguPushFailure(code: "owner_unavailable", message: "A current verified native owner is required") }
        guard current == binding, expected == nil || expected == generation else { throw GuguPushFailure.stale }
        if ownerUI {
            do { try requireOwnerUI() }
            catch let failure as GuguPushFailure { throw failure }
            catch { throw GuguPushFailure(code: "not_granted", message: "Open notification settings in the foreground application") }
        }
    }
    private func snapshot(_ settings: GuguPushSettings, binding: GuguPushBinding) -> GuguPushSnapshot {
        let ours = activeBinding == binding
        return .init(binding: binding, settings: settings, phase: ours ? phase : .none,
                     serverRegistered: ours && phase == .registered && receipt != nil && settings.visibleAlertsAllowed && receipt?.preferences == preferences(),
                     providerAvailable: provider != nil, apnsCallbackPending: platform.registrationPending)
    }
}
