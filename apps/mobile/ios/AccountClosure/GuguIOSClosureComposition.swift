import Foundation

/// The controller owns flow ordering and pending retries. No network call here.
enum GuguIOSClosureComposition {
    static func make(root: URL, ownerSession: GuguIOSOwnerSession,
                     installation: @escaping () throws -> String,
                     prepare: @escaping (String) throws -> Bool,
                     hasUnattributedPush: @escaping () -> Bool) -> GuguIOSAccountClosure {
        let bundle = Bundle.main.bundleIdentifier ?? "app.gugu.chat"
        let slot = GuguIOSClosureAuthSlot(bundleIdentifier: bundle)
        let files = GuguIOSClosureFiles(root: root)
        let retirement = GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("retirement", isDirectory: true))
        let preparation: (GuguIOSClosureScope) throws -> Bool = { scope in
            guard try prepare(scope.ownerId) else { return false }
            var ready = false
            try ownerSession.withLocalClosureStorage { ready = try retirement.prepareLocalErase(ownerId: scope.ownerId) }
            return ready
        }
        var steps: [(GuguIOSClosureScope) throws -> Bool] = [
            { scope in
                try ownerSession.withLocalClosureStorage { try slot.eraseMainIfOwned(by: scope.ownerId) }
                return true
            },
        ]
        steps += GuguIOSClosureFiles.directories.map { directory in
            { scope in try files.erase(ownerId: scope.ownerId, directory: directory); return true }
        }
        return GuguIOSAccountClosure(secrets: GuguIOSClosureKeychain(bundleIdentifier: bundle),
            installation: installation, localAuthBarrier: { body in try ownerSession.withLocalClosureStorage(body) },
            mainOwner: slot.owner,
            capturePreparation: { scope in try ownerSession.preparedSignOut(expectedOwnerId: scope.ownerId) },
            cancelPreparation: { scope, preparation in try ownerSession.cancelSignOut(expectedOwnerId: scope.ownerId, preparation: preparation) },
            preparation: preparation, steps: steps, retained: {
                var names = try slot.retainedUnattributed()
                let staging = FileManager.default.temporaryDirectory.appendingPathComponent("GuguSaveFiles", isDirectory: true)
                if FileManager.default.fileExists(atPath: staging.path),
                   (try? FileManager.default.contentsOfDirectory(atPath: staging.path).isEmpty) != true { names.append("files-staging") }
                if let snapshot = try retirement.snapshot(), snapshot.original == nil, snapshot.target.ownerId == nil { names.append("retirement-unattributed") }
                if hasUnattributedPush() { names.append("push-deduplication") }
                return names.sorted()
            })
    }
}
