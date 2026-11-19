import Foundation
import Security

final class GuguIOSClosureV2Composition {
    let operations: GuguIOSClosureV2Operation
    let facade: GuguIOSClosureV2Facade
    init(root: URL, bundleIdentifier: String, ownerSession: GuguIOSOwnerSession,
         installation: GuguIOSInstallation, configuration: GuguIOSBackendConfiguration,
         prepare: @escaping (GuguIOSClosureV2Record, Bool) async throws -> Bool,
         hasUnattributedPush: @escaping () -> Bool) throws {
        let keychain = GuguIOSOwnerKeychain(bundleIdentifier: bundleIdentifier)
        let auth = GuguIOSClosureAuthSlot(bundleIdentifier: bundleIdentifier)
        let files = GuguIOSClosureFiles(root: root)
        let retirement = GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("retirement", isDirectory: true))
        let transport = try GuguIOSClosureV2HTTP(configuration: configuration)
        weak var capturedStore: GuguIOSClosureV2Operation?
        let store = GuguIOSClosureV2Operation(secrets: GuguIOSClosureKeychain(bundleIdentifier: bundleIdentifier),
            barrier: { try ownerSession.withLocalClosureStorage($0) }, identity: { owner, recovering in
                let stored = try keychain.read()
                let installed = try installation.existingIdentifier()
                let sid: String
                if let stored {
                    guard stored.ownerId == owner else { throw GuguIOSClosureV2Operation.failure("wrong_local_owner") }
                    sid = try GuguIOSOwnerCredentials.sessionId(ownerId: owner, accessToken: stored.accessToken)
                } else {
                    guard recovering, let original = try capturedStore?.protectedRecord(ownerId: owner) else {
                        throw GuguIOSClosureV2Operation.failure("unauthorized")
                    }
                    sid = original.originalSessionId
                }
                return .init(ownerId: stored?.ownerId ?? owner, sessionId: sid, installationId: installed,
                    deviceId: "phone-\(installed)-\(owner)", backend: transport.backendIdentity, authenticated: stored != nil)
            }, entropy: {
                var receipt = Data(count: 32)
                let status = receipt.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
                guard status == errSecSuccess else { throw GuguIOSClosureV2Operation.failure("closure_storage_unavailable") }
                return receipt
            }, captureAdmission: { _ in
                // An unfinished ordinary/V1 retirement cannot be overwritten by a new V2 capability.
                guard try retirement.snapshot() == nil else { throw GuguIOSClosureV2Operation.failure("closure_recovery_required") }
            })
        capturedStore = store; operations = store
        facade = GuguIOSClosureV2Facade(store: store, transport: transport, session: {
            guard let stored = try keychain.read() else { return nil }
            return .init(ownerId: stored.ownerId,
                sessionId: try GuguIOSOwnerCredentials.sessionId(ownerId: stored.ownerId, accessToken: stored.accessToken), accessToken: stored.accessToken)
        }, prepareLocal: prepare, erase: { step, owner in
            if step == 0 { try auth.retireMainIfOwned(by: owner) }
            else { try files.erase(ownerId: owner, directory: GuguIOSClosureFiles.directories[step - 1]) }
        }, retained: {
            var names = try auth.retainedUnattributed()
            let staging = FileManager.default.temporaryDirectory.appendingPathComponent("GuguSaveFiles", isDirectory: true)
            if FileManager.default.fileExists(atPath: staging.path),
               (try? FileManager.default.contentsOfDirectory(atPath: staging.path).isEmpty) != true { names.append("files-staging") }
            if let record = try retirement.snapshot(), record.original == nil, record.target.ownerId == nil { names.append("retirement-unattributed") }
            if hasUnattributedPush() { names.append("push-deduplication") }
            return names.sorted()
        }, beforeCapture: { _ = try installation.identifier() })
    }
}
