#if os(iOS)
import Capacitor
import Foundation
import UIKit

private final class GuguUnavailableNativeExecutor: GuguNativeToolExecutor {
    private var failure: GuguHostFailure { .init(code: "host_not_ready", message: "Native App runtime is unavailable") }
    func validateAccess(_ control: GuguNativeToolControl) throws { throw failure }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl,
                 completion: @escaping ([String: Any]) -> Void) { completion(failure.envelope) }
}

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
    private let hostServiceLock = NSRecursiveLock()
    private var hostServiceStorage: GuguIOSHostService?
    let backendConfiguration: GuguIOSBackendConfiguration
    let calendarStore = EventKitPhoneCalendarStore()
    private lazy var calendarService: PhoneCalendarService = PhoneCalendarService(store: calendarStore)

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

    lazy var ownerSession: GuguIOSOwnerSession = GuguIOSOwnerSession(readStored: { [weak self] in
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
    }, retireExternal: { [weak self] capability, completion in
        Task { @MainActor in
            guard let self else { completion(.failure(Self.unavailable())); return }
            do { try await self.pushRetirement.retire(capability); completion(.success(())) }
            catch { completion(.failure(error)) }
        }
    }, retireNative: { [weak self] capability, completion in
        guard let self else { completion(.failure(Self.unavailable())); return }
        guard let capability else { completion(.success(())); return }
        self.retirementQueue.async {
            do {
                try self.nativeHostService().retireOwner(expectedBinding: capability.binding,
                    retirementId: capability.retirementId, completion: completion)
            } catch { completion(.failure(error)) }
        }
    }, retirementStore: GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("retirement", isDirectory: true)))

    /// Construction performs no configure/HTTP and does not register a plugin.
    /// The same instance must own ordinary calls and sealed native cleanup.
    private func nativeHostService() throws -> GuguIOSHostService {
        hostServiceLock.lock(); defer { hostServiceLock.unlock() }
        if let hostServiceStorage { return hostServiceStorage }
        let service = try GuguIOSHostService(root: root.appendingPathComponent("service", isDirectory: true),
            runtime: .load(), lifecycle: lifecycle, ownerAccess: ownerAccess, configuration: backendConfiguration,
            credentials: { [weak self] binding in
                guard let self else { throw Self.unavailable() }
                return try self.ownerSession.credentials(expectedBinding: binding)
            }, executor: { [weak self] binding in
                // This factory is retained by the App-lifetime service.
                guard let self else { return GuguUnavailableNativeExecutor() }
                return self.calendarExecutor(binding: binding)
            }, deviceMetadata: {
                ["label": "iPhone", "hostname": "iPhone", "osName": "iOS", "tier": "mobile",
                 "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"]
            }, retirementAuthorization: { [weak self] binding, retirementId, operation in
                guard let self else { throw Self.unavailable() }
                return try self.ownerSession.retirementAuthorization(expectedBinding: binding,
                    retirementId: retirementId, operation: operation)
            })
        hostServiceStorage = service
        return service
    }

    // Cleanup needs no APNs environment and never exposes registration. The
    // ordinary provider remains absent until signed-build configuration and
    // actual renderer preference/reconciliation wiring are available.
    @MainActor private lazy var pushPlatform: GuguUNPushPlatform = GuguUNPushPlatform(onUnsolicitedCallback: { [weak self] in
        self?.pushCleanupClient.invalidate()
    })
    @MainActor private lazy var pushCleanupClient: GuguPushClient = GuguPushClient(platform: pushPlatform, provider: nil,
        currentBinding: { [weak self] in
            guard let self else { throw Self.unavailable() }
            let binding = try self.currentBinding()
            return .init(ownerId: binding.ownerId, deviceId: binding.deviceId, installationId: binding.installationId)
        }, requireOwnerUI: { try Self.requireForegroundOwnerUI() },
        preferences: { .init(chatEnabled: false, taskEnabled: false, chatSoundEnabled: false, taskSoundEnabled: false) },
        foregroundPresentation: { _ in false }, onHint: { _ in })
    @MainActor private lazy var pushRetirement: GuguIOSPushRetirement = GuguIOSPushRetirement(ownerSession: ownerSession,
        client: pushCleanupClient, close: { [weak self] scope, capability in
            guard let self else { throw Self.unavailable() }
            return try await GuguIOSPushRetirement.close(configuration: self.backendConfiguration,
                ownerSession: self.ownerSession, capability: capability, scope: scope)
        })

    lazy var lifecycle: GuguIOSHostLifecycle = GuguIOSHostLifecycle(root: root.appendingPathComponent("host", isDirectory: true),
        verifiedIdentity: { [weak self] in
            guard let self else { throw Self.unavailable() }; return try self.currentBinding()
        })

    lazy var ownerAccess: GuguIOSOwnerAccess = GuguIOSOwnerAccess(root: root.appendingPathComponent("categories", isDirectory: true),
        verifiedIdentity: { [weak self] in
            guard let self else { throw Self.unavailable() }; return try self.currentBinding()
        }, requireOwnerUI: { try Self.requireForegroundOwnerUI() },
        calendarHasFullAccess: { [weak self] in self?.calendarStore.authorization == .fullAccess },
        revokeCalendarAccess: { [weak self] binding in
            guard let self else { throw Self.unavailable() }
            try self.lifecycle.revokeCalendarAccess(binding: binding)
        })

    func plugins() throws -> [CAPPlugin] {
        // Construct on the bridge's App startup thread before publishing plugins.
        // No real model host, cloud Agent or tool execution is created here.
        [GuguAuthStoragePlugin(ownerSession: ownerSession), GuguIOSOwnerPlugin(ownerSession: ownerSession),
         GuguCalendarPermissionsPlugin(store: calendarStore, ownerAccess: ownerAccess),
         GuguAgentPlugin(service: try nativeHostService())]
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
