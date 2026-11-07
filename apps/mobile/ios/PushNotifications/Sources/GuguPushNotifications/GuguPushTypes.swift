import Foundation

struct GuguPushFailure: Error, Equatable {
    let code: String
    let message: String
    static let stale = Self(code: "stale_context", message: "Notification owner or registration changed")
    static let unavailable = Self(code: "backend_unavailable", message: "Notification registration service is unavailable")
    static let permission = Self(code: "os_permission", message: "Allow visible notifications in system settings")
    static let busy = Self(code: "registration_pending", message: "An APNs registration callback is still pending")
}

struct GuguPushBinding: Equatable {
    let ownerId: String
    let deviceId: String
    let installationId: String

    func validate() throws {
        guard UUID(uuidString: ownerId)?.uuidString.lowercased() == ownerId,
              UUID(uuidString: installationId)?.uuidString.lowercased() == installationId,
              deviceId == "phone-\(installationId)-\(ownerId)" else { throw GuguPushFailure.stale }
    }
    var json: [String: String] {
        ["ownerId": ownerId, "deviceId": deviceId, "installationId": installationId]
    }
}

enum GuguPushAuthorization: String { case notDetermined, denied, authorized, provisional, ephemeral, unknown }
enum GuguPushSetting: String { case enabled, disabled, notSupported, unknown }

struct GuguPushSettings: Equatable {
    let authorization: GuguPushAuthorization
    let alert: GuguPushSetting
    let sound: GuguPushSetting
    let badge: GuguPushSetting
    let notificationCenter: GuguPushSetting
    let lockScreen: GuguPushSetting
    var visibleAlertsAllowed: Bool {
        (authorization == .authorized || authorization == .ephemeral) && alert == .enabled
    }
}

struct GuguPushTicket: Equatable {
    let binding: GuguPushBinding
    let generation: UUID
}

struct GuguPushPreferences: Equatable {
    let chatEnabled: Bool
    let taskEnabled: Bool
    let soundEnabled: Bool
    func allows(_ kind: GuguPushKind) -> Bool { kind == .chatMessage ? chatEnabled : taskEnabled }
}
enum GuguPushEnvironment: String { case sandbox, production }
enum GuguPushKind: String { case chatMessage = "chat_message", taskAttention = "task_attention" }

/// Memory only; never Codable, returned to JavaScript, or used in diagnostics.
final class GuguPushRegistrationRequest: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    let ticket: GuguPushTicket
    let preferences: GuguPushPreferences
    private let deviceToken: Data
    init(ticket: GuguPushTicket, preferences: GuguPushPreferences, deviceToken: Data) {
        self.ticket = ticket; self.preferences = preferences; self.deviceToken = deviceToken
    }
    func withDeviceToken<T>(_ use: (Data) throws -> T) rethrows -> T { try use(deviceToken) }
    var description: String { "APNs registration request (token redacted)" }
    var debugDescription: String { description }
    var customMirror: Mirror { Mirror(self, children: [:]) }
}

struct GuguPushRegistrationReceipt: Equatable {
    let ticket: GuguPushTicket
    let registrationId: String
    let serverGeneration: UUID
    let preferences: GuguPushPreferences
    func validate() throws {
        try ticket.binding.validate()
        guard UUID(uuidString: registrationId)?.uuidString.lowercased() == registrationId else {
            throw GuguPushFailure(code: "registration_unknown", message: "Notification registration was not confirmed")
        }
    }
}

struct GuguPushRevocationRequest {
    let receipt: GuguPushRegistrationReceipt
    var ticket: GuguPushTicket { receipt.ticket }
    var registrationId: String { receipt.registrationId }
}

/// A register ack contains SERVER generation, distinct from the native ticket.
/// Revoke returns true only for removal of that exact server registration.
@MainActor protocol GuguPushProvider: AnyObject {
    func register(_ request: GuguPushRegistrationRequest) async throws -> GuguPushRegistrationReceipt
    func revoke(_ request: GuguPushRevocationRequest) async throws -> Bool
}

@MainActor protocol GuguPushPlatform: AnyObject {
    var registrationPending: Bool { get }
    func settings() async -> GuguPushSettings
    func requestAuthorization(check: @escaping () throws -> Void) async throws
    func deviceToken(ticket: GuguPushTicket, check: @escaping () throws -> Void) async throws -> Data
    func unregister()
    func clearDelivered()
}

enum GuguPushPhase: String { case none, awaitingAPNs, registering, registered, revoking, revoked, blocked, failed }
enum GuguPushEventKind: String { case received, opened }
struct GuguPushEnvelope {
    let binding: GuguPushBinding
    let registrationId: String
    let serverGeneration: UUID
    let eventId: String
    let kind: GuguPushKind
    let revision: String
}
struct GuguPushReconciliationHint {
    let receipt: GuguPushRegistrationReceipt
    let eventId: String
    let kind: GuguPushEventKind
    let notificationKind: GuguPushKind
    let revision: String
}

enum GuguPushPresentation { case none, alert, alertWithSound }

struct GuguPushSnapshot {
    let binding: GuguPushBinding
    let settings: GuguPushSettings
    let phase: GuguPushPhase
    let serverRegistered: Bool
    let providerAvailable: Bool
    let apnsCallbackPending: Bool
    var json: [String: Any] {
        ["binding": binding.json, "authorization": settings.authorization.rawValue,
         "alert": settings.alert.rawValue, "sound": settings.sound.rawValue, "badge": settings.badge.rawValue,
         "notificationCenter": settings.notificationCenter.rawValue, "lockScreen": settings.lockScreen.rawValue,
         "visibleAlertsAllowed": settings.visibleAlertsAllowed, "registration": phase.rawValue,
         "serverRegistered": serverRegistered, "providerAvailable": providerAvailable,
         "apnsCallbackPending": apnsCallbackPending]
    }
}
