import Foundation

/// The native credential-write barrier. Empty local push state never proves
/// server cleanup; only a matching original-session close can release the write.
@MainActor final class GuguIOSPushRetirement {
    typealias Close = (GuguPushRetirementScope, GuguIOSRetirementAccess) async throws -> GuguPushCleanupEvidence
    private let ownerSession: GuguIOSOwnerSession
    private let client: GuguPushClient
    private let close: Close

    init(ownerSession: GuguIOSOwnerSession, client: GuguPushClient, close: @escaping Close) {
        self.ownerSession = ownerSession; self.client = client; self.close = close
    }

    /// Used by the App and the injected composition check with identical request
    /// authorization. This provider has no register/revoke or APNs environment.
    static func close(configuration: GuguIOSBackendConfiguration, ownerSession: GuguIOSOwnerSession,
                      capability: GuguIOSRetirementAccess, scope: GuguPushRetirementScope,
                      send: GuguIOSPushTransport.Send? = nil) async throws -> GuguPushCleanupEvidence {
        let binding = capability.binding
        guard scope.binding == GuguPushBinding(ownerId: binding.ownerId, deviceId: binding.deviceId,
                                               installationId: binding.installationId) else { throw GuguPushFailure.stale }
        let transport = try GuguIOSPushTransport(configuration: configuration,
            authorize: { function, _, expected in
                guard function == "mobile_push_close_installation", expected == binding else { throw GuguPushFailure.stale }
                let original = try ownerSession.retirementCredentials(capability, expectedBinding: binding)
                guard try original.originalSessionId() == scope.originalSessionId else { throw GuguPushFailure.stale }
                return .init(credentials: original, validateReceipt: {
                    let current = try ownerSession.retirementCredentials(capability, expectedBinding: binding)
                    guard try current.originalSessionId() == scope.originalSessionId else { throw GuguPushFailure.stale }
                })
            }, send: send)
        return try await GuguPushRPCProvider(retirementTransport: transport).closeInstallation(scope: scope)
    }

    func retire(_ capability: GuguIOSRetirementAccess?) async throws {
        // No original credential envelope exists on first login. This does not
        // assert that an old server scope was cleaned; none is admitted here.
        guard let capability else { client.invalidate(); return }
        let binding = capability.binding
        let push = GuguPushBinding(ownerId: binding.ownerId, deviceId: binding.deviceId,
                                   installationId: binding.installationId)
        let validate: GuguPushClient.RetirementBinding = { expected in
            guard expected == push else { throw GuguPushFailure.stale }
            let original = try self.ownerSession.retirementCredentials(capability, expectedBinding: binding)
            return .init(binding: push, originalSessionId: try original.originalSessionId())
        }
        let scope = try validate(push)
        let report = try await client.retire(expectedBinding: push, retirementBinding: validate,
            cleanupEvidence: { expected in
                guard expected == scope else { throw GuguPushFailure.stale }
                let proof = try await self.close(expected, capability)
                try proof.validate(expectedScope: scope)
                return proof
            })
        guard try validate(push) == scope, report.serverCleanupVerified,
              let evidence = report.cleanupEvidence else {
            throw GuguPushFailure(code: "revocation_unknown", message: "Original notification installation cleanup remains unverified")
        }
        try evidence.validate(expectedScope: scope)
    }
}
