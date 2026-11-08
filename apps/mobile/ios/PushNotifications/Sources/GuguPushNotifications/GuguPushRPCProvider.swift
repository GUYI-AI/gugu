import Foundation
import CoreFoundation

/// Inject the existing authenticated native client; no URL, token or refresh
/// authority comes from JavaScript. It must recheck its purpose-bound native
/// credential capability before I/O and before returning a result.
@MainActor protocol GuguPushRPCTransport: AnyObject {
    func call(_ function: String, parameters: [String: Any], binding: GuguPushBinding) async throws -> Any
}

/// Register/revoke mapping frozen at gugu-supabase 94fb939d29e6ac004a3ac26b24eca7ceead550d4.
/// Close contract additionally frozen by the backend owner on 2026-11-08.
/// No HTTP implementation or environment fallback. Configuration comes from
/// the actual signed build, never a WebView parameter.
@MainActor final class GuguPushRPCProvider: GuguPushProvider {
    private let transport: GuguPushRPCTransport
    private let environment: GuguPushEnvironment
    init(transport: GuguPushRPCTransport, environment: GuguPushEnvironment) {
        self.transport = transport; self.environment = environment
    }
    func register(_ request: GuguPushRegistrationRequest) async throws -> GuguPushRegistrationReceipt {
        try request.ticket.binding.validate()
        let parameters: [String: Any] = try request.withDeviceToken { bytes in
            guard !bytes.isEmpty, bytes.count <= 2048 else {
                throw GuguPushFailure(code: "invalid_args", message: "APNs token exceeds protocol bounds")
            }
            return ["p_installation_id": request.ticket.binding.installationId,
                    "p_device_id": request.ticket.binding.deviceId,
                    "p_token": bytes.map { String(format: "%02x", $0) }.joined(),
                    "p_environment": environment.rawValue, "p_topic": "app.gugu.chat",
                    "p_chat_enabled": request.preferences.chatEnabled,
                    "p_task_enabled": request.preferences.taskEnabled,
                    "p_sound_enabled": request.preferences.soundEnabled]
        }
        let raw: Any
        do { raw = try await transport.call("mobile_push_register", parameters: parameters, binding: request.ticket.binding) }
        catch { throw GuguPushFailure(code: "registration_unknown", message: "Notification registration was not confirmed") }
        guard let object = raw as? [String: Any], let id = object["registration_id"] as? String,
              let value = object["generation"] as? String, let generation = UUID(uuidString: value),
              generation.uuidString.lowercased() == value else {
            throw GuguPushFailure(code: "registration_unknown", message: "Notification registration response is invalid")
        }
        let receipt = GuguPushRegistrationReceipt(ticket: request.ticket, registrationId: id,
                                                serverGeneration: generation, preferences: request.preferences)
        try receipt.validate(); return receipt
    }
    func revoke(_ request: GuguPushRevocationRequest) async throws -> Bool {
        try request.receipt.validate()
        let raw: Any
        do {
            raw = try await transport.call("mobile_push_revoke", parameters: [
                "p_installation_id": request.ticket.binding.installationId,
                "p_registration_id": request.registrationId,
                "p_generation": request.receipt.serverGeneration.uuidString.lowercased(),
            ], binding: request.ticket.binding)
        } catch { throw GuguPushFailure(code: "revocation_unknown", message: "Server notification revocation was not confirmed") }
        // Reject numeric/string truthiness: only an actual JSON boolean counts.
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw GuguPushFailure(code: "revocation_unknown", message: "Notification revocation response is invalid")
        }
        return number.boolValue
    }
    /// Native retirement only. Transport must authorize this exact original JWT
    /// session and parameters with the still-valid restricted retirement cap.
    func closeInstallation(scope: GuguPushRetirementScope) async throws -> GuguPushCleanupEvidence {
        try scope.validate()
        let raw: Any
        do {
            raw = try await transport.call("mobile_push_close_installation", parameters: [
                "p_installation_id": scope.binding.installationId,
                "p_device_id": scope.binding.deviceId,
                "p_original_session_id": scope.originalSessionId,
            ], binding: scope.binding)
        } catch { throw GuguPushFailure(code: "revocation_unknown", message: "Notification installation close was not confirmed") }
        guard let object = raw as? [String: Any],
              let version = object["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let closed = object["closed"] as? NSNumber, CFGetTypeID(closed) == CFBooleanGetTypeID(), closed.boolValue,
              object["owner_id"] as? String == scope.binding.ownerId,
              object["session_id"] as? String == scope.originalSessionId,
              object["installation_id"] as? String == scope.binding.installationId,
              object["device_id"] as? String == scope.binding.deviceId,
              let value = object["evidence"] as? String, let kind = GuguPushCleanupKind(rawValue: value),
              object.keys.contains("fence_id"), object["fence_id"] is String || object["fence_id"] is NSNull else {
            throw GuguPushFailure(code: "revocation_unknown", message: "Notification installation close response is invalid")
        }
        let proof = GuguPushCleanupEvidence(scope: scope, kind: kind, fenceId: object["fence_id"] as? String)
        try proof.validate(expectedScope: scope)
        return proof
    }
}

enum GuguPushPayload {
    static func decode(_ userInfo: [AnyHashable: Any]) -> GuguPushEnvelope? {
        guard let object = userInfo["gugu"] as? [String: Any],
              let version = object["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let owner = uuid(object["ownerId"]), let installation = uuid(object["installationId"]),
              let registration = uuid(object["registrationId"]), let generation = uuid(object["generation"]),
              let event = uuid(object["notificationId"]), let rawKind = object["kind"] as? String,
              let kind = GuguPushKind(rawValue: rawKind), let revision = object["revision"] as? String,
              validRevision(revision) else { return nil }
        return .init(binding: .init(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation),
                     registrationId: registration, serverGeneration: UUID(uuidString: generation)!,
                     eventId: event, kind: kind, revision: revision)
    }
    static func validRevision(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 19 && value.utf8.allSatisfy { (48...57).contains($0) } &&
        (value == "0" || value.first != "0") && UInt64(value).map { $0 <= UInt64(Int64.max) } == true
    }
    private static func uuid(_ value: Any?) -> String? {
        guard let value = value as? String, UUID(uuidString: value)?.uuidString.lowercased() == value else { return nil }
        return value
    }
}
