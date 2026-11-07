#if os(iOS)
import Capacitor
import Foundation
import UIKit

/// One App-lifetime assembly. Calendar settings and the task backend share the
/// same native owner and journal custody; a new WebView does not create a host.
final class GuguIOSAppRuntime {
    private static let singletonLock = NSLock()
    private static var singleton: GuguIOSAppRuntime?
    private let root: URL
    private let keychain: GuguIOSOwnerKeychain
    private let installation: GuguIOSInstallation
    private let verifier: GuguIOSOwnerVerifier
    private let retirementQueue = DispatchQueue(label: "app.gugu.native-retirement", qos: .userInitiated)
    let backendConfiguration: GuguIOSBackendConfiguration
    let calendarStore = EventKitPhoneCalendarStore()
    private lazy var calendarService = PhoneCalendarService(store: calendarStore)

    static func open() throws -> GuguIOSAppRuntime {
        singletonLock.lock(); defer { singletonLock.unlock() }
        if let singleton { return singleton }
        let created = try GuguIOSAppRuntime()
        singleton = created
        return created
    }

    private init() throws {
        guard let identifier = Bundle.main.bundleIdentifier else {
            throw GuguHostFailure(code: "installation_unavailable", message: "Native application identity is missing")
        }
        backendConfiguration = try .load()
        verifier = try GuguIOSOwnerVerifier(configuration: backendConfiguration)
        keychain = GuguIOSOwnerKeychain(bundleIdentifier: identifier)
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true)
        root = support.appendingPathComponent("GuguNative", isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var directory = root, flags = URLResourceValues(); flags.isExcludedFromBackup = true
        try directory.setResourceValues(flags)
        installation = GuguIOSInstallation(directory: root.appendingPathComponent("installation", isDirectory: true))
    }

    lazy var ownerSession = GuguIOSOwnerSession(readStored: { [weak self] in
        guard let self else { throw Self.unavailable() }; return try self.keychain.read()
    }, installationId: { [weak self] in
        guard let self else { throw Self.unavailable() }; return try self.installation.identifier()
    }, verifyUser: { [weak self] token, completion in
        guard let self else { completion(.failure(Self.unavailable())); return }
        self.verifier.verify(accessToken: token, completion: completion)
    }, stopNative: { [weak self] completion in
        guard let self else { completion(.failure(Self.unavailable())); return }
        self.retirementQueue.async {
            do { try self.lifecycle.stopAll(); completion(.success(())) }
            catch { completion(.failure(error)) }
        }
    })

    lazy var lifecycle = GuguIOSHostLifecycle(root: root.appendingPathComponent("host", isDirectory: true),
        verifiedIdentity: { [weak self] in
            guard let self else { throw Self.unavailable() }; return try self.currentBinding()
        })

    lazy var ownerAccess = GuguIOSOwnerAccess(root: root.appendingPathComponent("categories", isDirectory: true),
        verifiedIdentity: { [weak self] in
            guard let self else { throw Self.unavailable() }; return try self.currentBinding()
        }, requireOwnerUI: { try Self.requireForegroundOwnerUI() },
        calendarHasFullAccess: { [weak self] in self?.calendarStore.authorization == .fullAccess },
        revokeCalendarAccess: { [weak self] in
            guard let self else { throw Self.unavailable() }
            try self.lifecycle.revokeCalendarAccess(binding: self.currentBinding())
        })

    func plugins() -> [CAPPlugin] {
        // Construct on the bridge's App startup thread before publishing plugins.
        // No real model host, cloud Agent or tool execution is created here.
        [GuguAuthStoragePlugin(ownerSession: ownerSession), GuguIOSOwnerPlugin(ownerSession: ownerSession),
         GuguCalendarPermissionsPlugin(store: calendarStore, ownerAccess: ownerAccess)]
    }

    func currentBinding() throws -> GuguIOSHostBinding {
        guard let stored = try keychain.read() else {
            throw GuguHostFailure(code: "auth_unavailable", message: "A current shared login is required")
        }
        return try ownerSession.binding(expectedOwnerId: stored.ownerId)
    }

    func calendarExecutor(binding: GuguIOSHostBinding) -> GuguNativeToolExecutor {
        GuguCalendarExecutor(service: calendarService, calendarEnabled: { [weak self] in
            guard let self else { throw Self.unavailable() }
            return try self.ownerAccess.calendarEnabled(expectedBinding: binding)
        })
    }

    private static func requireForegroundOwnerUI() throws {
        let foreground = {
            UIApplication.shared.applicationState == .active && UIApplication.shared.connectedScenes.contains { scene in
                guard let scene = scene as? UIWindowScene, scene.activationState == .foregroundActive else { return false }
                return scene.windows.contains { $0.isKeyWindow }
            }
        }
        let allowed = Thread.isMainThread ? foreground() : DispatchQueue.main.sync(execute: foreground)
        guard allowed else { throw GuguHostFailure(code: "not_granted", message: "Open Calendar settings in the foreground application") }
    }
    private static func unavailable() -> GuguHostFailure {
        GuguHostFailure(code: "host_not_ready", message: "Native application runtime is unavailable")
    }
}
#endif
