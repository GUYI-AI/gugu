#if os(iOS)
import Capacitor
import Foundation
import UIKit
import UserNotifications

@objc(GuguPushNotificationsPlugin)
final class GuguPushNotificationsPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "GuguPushNotificationsPlugin"
    let jsName = "GuguPushNotifications"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "suspend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "revoke", returnType: CAPPluginReturnPromise),
    ]
    private let client: GuguPushClient
    private var selected = GuguPushPreferences(chatEnabled: false, taskEnabled: false, chatSoundEnabled: false, taskSoundEnabled: false)
    private var selectedBinding: GuguPushBinding?
    private var initializationFailure: Error?
    private var tokenObserver: NSObjectProtocol?
    private var notificationDelegate: GuguPushForwardingDelegate?
    @MainActor init(client: GuguPushClient, platform: GuguUNPushPlatform,
                    ownerSession: GuguIOSOwnerSession, configuration: GuguIOSBackendConfiguration) {
        self.client = client; super.init()
        do {
            // Same Xcode value as App.entitlements. Export must verify the signed
            // entitlement against this value; staging DB does not select APNs.
            let setting = Bundle.main.object(forInfoDictionaryKey: "GuguAPNsEnvironment") as? String
            let environment: GuguPushEnvironment
            switch setting {
            case "development": environment = .sandbox
            case "production": environment = .production
            default: throw GuguPushFailure.unavailable
            }
            let transport = try GuguIOSPushTransport(configuration: configuration, authorize: { function, _, binding in
                guard function == "mobile_push_register" || function == "mobile_push_revoke" else { throw GuguPushFailure.unavailable }
                let issued = try ownerSession.credentials(expectedBinding: binding)
                return .init(credentials: issued, validateReceipt: { try ownerSession.validateIssuedPushReceipt(issued) })
            })
            client.connect(provider: GuguPushRPCProvider(transport: transport, environment: environment),
                preferences: { [weak self] in self?.selected ?? .init(chatEnabled: false, taskEnabled: false, chatSoundEnabled: false, taskSoundEnabled: false) },
                onHint: { [weak self] hint in
                    self?.notifyListeners("reconcile", data: ["ownerId": hint.receipt.ticket.binding.ownerId,
                        "kind": hint.kind.rawValue, "revision": hint.revision, "chatId": (hint.chatId as Any?) ?? NSNull()], retainUntilConsumed: true)
                })
            tokenObserver = NotificationCenter.default.addObserver(forName: Notification.Name("GuguAPNsTokenChanged"), object: nil, queue: .main) { [weak self] _ in
                self?.notifyListeners("tokenChanged", data: [:])
            }
            GuguPushAppCallbacks.platform = platform
            let delegate = GuguPushForwardingDelegate(client: client, previous: UNUserNotificationCenter.current().delegate)
            notificationDelegate = delegate
            UNUserNotificationCenter.current().delegate = delegate
        } catch { initializationFailure = error }
    }

    deinit { if let tokenObserver { NotificationCenter.default.removeObserver(tokenObserver) } }

    @objc func suspend(_ call: CAPPluginCall) {
        Task { @MainActor in
            selectedBinding = nil; client.invalidate(); call.resolve()
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        do {
            let binding = try expected(call)
            guard initializationFailure == nil,
                  let chat = call.getBool("chatEnabled"), let task = call.getBool("taskEnabled"),
                  let chatSound = call.getBool("chatSoundEnabled"), let taskSound = call.getBool("taskSoundEnabled") else {
                throw GuguPushFailure.unavailable
            }
            Task { @MainActor in
                do {
                    _ = try await client.status(expectedBinding: binding)
                    client.invalidate()
                    selected = .init(chatEnabled: chat, taskEnabled: task, chatSoundEnabled: chatSound, taskSoundEnabled: taskSound)
                    selectedBinding = binding
                    call.resolve()
                } catch { call.reject("Notification preferences are unavailable", "push_unavailable") }
            }
        } catch { call.reject("Notification preferences are unavailable", "push_unavailable") }
    }

    private func expected(_ call: CAPPluginCall) throws -> GuguPushBinding {
        guard let object = call.getObject("expectedBinding"), let owner = object["ownerId"] as? String,
              let device = object["deviceId"] as? String, let install = object["installationId"] as? String else {
            throw GuguPushFailure(code: "invalid_args", message: "Current notification owner binding is required")
        }
        let value = GuguPushBinding(ownerId: owner, deviceId: device, installationId: install)
        try value.validate(); return value
    }

    private func run(_ call: CAPPluginCall, operation: @escaping @MainActor (GuguPushBinding) async throws -> GuguPushSnapshot) {
        do {
            let binding = try expected(call)
            Task { @MainActor in
                do { call.resolve(try await operation(binding).json) }
                catch let failure as GuguPushFailure { call.reject(failure.message, failure.code) }
                catch { call.reject("Notification operation was not confirmed", "push_failed") }
            }
        } catch let failure as GuguPushFailure { call.reject(failure.message, failure.code) }
        catch { call.reject("Notification operation was not confirmed", "push_failed") }
    }

    @objc func status(_ call: CAPPluginCall) {
        run(call) { try await self.client.status(expectedBinding: $0) }
    }
    @objc func requestAuthorization(_ call: CAPPluginCall) {
        run(call) { try await self.client.requestAuthorization(expectedBinding: $0) }
    }
    @objc func register(_ call: CAPPluginCall) {
        run(call) {
            guard self.selectedBinding == $0, self.initializationFailure == nil else { throw GuguPushFailure.unavailable }
            return try await self.client.register(expectedBinding: $0)
        }
    }
    @objc func revoke(_ call: CAPPluginCall) {
        run(call) { try await self.client.revoke(expectedBinding: $0) }
    }
}
/// AppDelegate forwards raw callbacks without logging sensitive token/error data.
@MainActor enum GuguPushAppCallbacks {
    static weak var platform: GuguUNPushPlatform?
}

/// Preserve Capacitor local notification handling. Remote foreground banners are
/// suppressed here; authenticated canonical updates use the existing local outlet.
@MainActor final class GuguPushForwardingDelegate: NSObject, UNUserNotificationCenterDelegate {
    private let remote: GuguPushNotificationDelegate
    private let previous: UNUserNotificationCenterDelegate?
    init(client: GuguPushClient, previous: UNUserNotificationCenterDelegate?) {
        remote = GuguPushNotificationDelegate(client: client, decode: GuguPushPayload.decode)
        self.previous = previous
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            if notification.request.trigger is UNPushNotificationTrigger {
                remote.userNotificationCenter(center, willPresent: notification, withCompletionHandler: completionHandler)
            } else if let previous, previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
                previous.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
            } else { completionHandler([]) }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            if response.notification.request.trigger is UNPushNotificationTrigger {
                remote.userNotificationCenter(center, didReceive: response, withCompletionHandler: completionHandler)
            } else if let previous, previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
                previous.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
            } else { completionHandler() }
        }
    }
}
#endif
