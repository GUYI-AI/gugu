#if os(iOS)
import Foundation
import UIKit
@preconcurrency import UserNotifications

/// A owns forwarding of AppDelegate token callbacks to this App-lifetime object.
/// APNs has no per-request callback identifier: never overlap token requests.
@MainActor final class GuguUNPushPlatform: GuguPushPlatform {
    private let center: UNUserNotificationCenter
    private let onUnsolicitedCallback: () -> Void
    private var tokenContinuation: CheckedContinuation<Data, Error>?
    var registrationPending: Bool { tokenContinuation != nil }

    init(center: UNUserNotificationCenter = .current(), onUnsolicitedCallback: @escaping () -> Void) {
        self.center = center; self.onUnsolicitedCallback = onUnsolicitedCallback
    }

    func settings() async -> GuguPushSettings {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { settings in
                continuation.resume(returning: Self.project(settings))
            }
        }
    }

    func requestAuthorization(check: @escaping () throws -> Void) async throws {
        try check()
        let _: Bool = try await withCheckedThrowingContinuation { continuation in
            center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                if error != nil { continuation.resume(throwing: GuguPushFailure.permission) }
                else { continuation.resume(returning: granted) }
            }
        }
    }

    func deviceToken(ticket: GuguPushTicket, check: @escaping () throws -> Void) async throws -> Data {
        try ticket.binding.validate(); try check()
        guard tokenContinuation == nil else { throw GuguPushFailure.busy }
        return try await withCheckedThrowingContinuation { continuation in
            tokenContinuation = continuation
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(deviceToken: Data) {
        guard let continuation = tokenContinuation else {
            onUnsolicitedCallback()
            NotificationCenter.default.post(name: Notification.Name("GuguAPNsTokenChanged"), object: nil)
            return
        }
        tokenContinuation = nil
        continuation.resume(returning: deviceToken)
    }
    func didFailToRegister() {
        guard let continuation = tokenContinuation else { onUnsolicitedCallback(); return }
        tokenContinuation = nil
        continuation.resume(throwing: GuguPushFailure(code: "apns_registration_failed", message: "APNs registration failed; try again when connected"))
    }
    func unregister() {
        UIApplication.shared.unregisterForRemoteNotifications()
        // Do not release an outstanding continuation/ticket: a later OS callback
        // still belongs to the old request and must drain before a new request.
    }
    func clearDelivered() { center.removeAllDeliveredNotifications() }

    private nonisolated static func project(_ settings: UNNotificationSettings) -> GuguPushSettings {
        let authorization: GuguPushAuthorization
        switch settings.authorizationStatus {
        case .notDetermined: authorization = .notDetermined
        case .denied: authorization = .denied
        case .authorized: authorization = .authorized
        case .provisional: authorization = .provisional
        case .ephemeral: authorization = .ephemeral
        @unknown default: authorization = .unknown
        }
        return .init(authorization: authorization, alert: setting(settings.alertSetting),
                     sound: setting(settings.soundSetting), badge: setting(settings.badgeSetting),
                     notificationCenter: setting(settings.notificationCenterSetting), lockScreen: setting(settings.lockScreenSetting))
    }
    private nonisolated static func setting(_ value: UNNotificationSetting) -> GuguPushSetting {
        switch value {
        case .enabled: return .enabled
        case .disabled: return .disabled
        case .notSupported: return .notSupported
        @unknown default: return .unknown
        }
    }
}

/// Forward to it or install it at launch with a strong owner; it does not assign
/// UNUserNotificationCenter.delegate or replace Capacitor's existing delegate.
@MainActor final class GuguPushNotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    typealias Decoder = ([AnyHashable: Any]) -> GuguPushEnvelope?
    private let client: GuguPushClient
    private let decode: Decoder
    init(client: GuguPushClient, decode: @escaping Decoder) { self.client = client; self.decode = decode }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            guard notification.request.trigger is UNPushNotificationTrigger,
                  let envelope = decode(notification.request.content.userInfo) else { completionHandler([]); return }
            guard await client.handle(envelope, kind: .received) else { completionHandler([]); return }
            // A injects the existing on-screen/one-outlet policy; no default
            // foreground alert bypasses the local message consumer.
            switch client.presentation(for: envelope) {
            case .none: completionHandler([])
            case .alert: completionHandler([.banner, .list])
            case .alertWithSound: completionHandler([.banner, .list, .sound])
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            defer { completionHandler() }
            guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
                  response.notification.request.trigger is UNPushNotificationTrigger,
                  let envelope = decode(response.notification.request.content.userInfo) else { return }
            _ = await client.handle(envelope, kind: .opened)
        }
    }
}
#endif
