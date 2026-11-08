import CoreFoundation
import CryptoKit
import Foundation

/// Native-only request authority. The assembler distinguishes ordinary access
/// from a purpose-bound retirement capability; neither is supplied by JavaScript.
struct GuguIOSPushAuthority: CustomDebugStringConvertible {
    let credentials: GuguIOSOwnerCredentials
    let validateReceipt: () throws -> Void
    var debugDescription: String { "GuguIOSPushAuthority(<redacted>)" }
}

private final class GuguIOSPushRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Only the frozen push wire operations. A credential capability authorizes the
/// exact canonical request digest before I/O and validates a known receipt after it.
@MainActor final class GuguIOSPushTransport: GuguPushRPCTransport {
    typealias Authorize = (String, String, GuguIOSHostBinding) throws -> GuguIOSPushAuthority
    typealias Send = (URLRequest) async throws -> (Data, HTTPURLResponse)
    private let baseURL: URL
    private let anonKey: String
    private let authorize: Authorize
    private let send: Send
    private let session: URLSession?
    private let redirects: GuguIOSPushRedirects?

    init(configuration: GuguIOSBackendConfiguration, authorize: @escaping Authorize, send: Send? = nil) throws {
        baseURL = try configuration.baseURL(); anonKey = configuration.anonKey; self.authorize = authorize
        if let send { self.send = send; session = nil; redirects = nil }
        else {
            let delegate = GuguIOSPushRedirects(), settings = URLSessionConfiguration.ephemeral
            settings.httpCookieStorage = nil; settings.urlCache = nil
            settings.requestCachePolicy = .reloadIgnoringLocalCacheData
            settings.timeoutIntervalForRequest = 20; settings.timeoutIntervalForResource = 30
            let session = URLSession(configuration: settings, delegate: delegate, delegateQueue: nil)
            self.session = session; redirects = delegate
            self.send = { request in
                let (bytes, response) = try await session.data(for: request)
                guard let response = response as? HTTPURLResponse else { throw Self.failure("push_response_invalid") }
                return (bytes, response)
            }
        }
    }

    func call(_ function: String, parameters: [String: Any], binding: GuguPushBinding) async throws -> Any {
        try binding.validate()
        try Self.validate(function, parameters: parameters, binding: binding)
        let body = try JSONSerialization.data(withJSONObject: parameters, options: [.sortedKeys, .withoutEscapingSlashes])
        let digest = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        let native = GuguIOSHostBinding(ownerId: binding.ownerId, deviceId: binding.deviceId, installationId: binding.installationId)
        let authority = try authorize(function, digest, native)
        let ticket = authority.credentials
        guard ticket.binding == native, ticket.expiresAt > Date(), !ticket.accessToken.isEmpty,
              !ticket.accessToken.contains("\r"), !ticket.accessToken.contains("\n") else { throw Self.failure("auth_unavailable") }
        if function == "mobile_push_close_installation" {
            guard parameters["p_original_session_id"] as? String == (try ticket.originalSessionId()) else {
                throw Self.failure("stale_context")
            }
        }
        let url = baseURL.appendingPathComponent("rest/v1/rpc/" + function)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("identity", forHTTPHeaderField: "Content-Profile")
        request.setValue("identity", forHTTPHeaderField: "Accept-Profile")
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer " + ticket.accessToken, forHTTPHeaderField: "Authorization")
        let bytes: Data, response: HTTPURLResponse
        do { (bytes, response) = try await send(request) }
        catch { throw Self.failure("push_transport_unknown") }
        // A known response must remain bound to its original account/capability.
        // The assembler may retain an old authorized receipt for cleanup only.
        try authority.validateReceipt()
        guard response.url == url, (200..<300).contains(response.statusCode), bytes.count <= 65536 else {
            throw Self.failure("push_response_invalid")
        }
        do { return try JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]) }
        catch { throw Self.failure("push_response_invalid") }
    }

    private static func validate(_ function: String, parameters p: [String: Any], binding: GuguPushBinding) throws {
        guard p["p_installation_id"] as? String == binding.installationId else { throw failure("invalid_args") }
        switch function {
        case "mobile_push_register":
            let expected: Set<String> = ["p_installation_id", "p_device_id", "p_token", "p_environment", "p_topic", "p_chat_enabled", "p_task_enabled", "p_sound_enabled"]
            guard Set(p.keys) == expected, p["p_device_id"] as? String == binding.deviceId,
                  p["p_topic"] as? String == "app.gugu.chat", let environment = p["p_environment"] as? String,
                  GuguPushEnvironment(rawValue: environment) != nil, let token = p["p_token"] as? String,
                  !token.isEmpty, token.utf8.count <= 4096, token.utf8.count.isMultiple(of: 2),
                  token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw failure("invalid_args") }
            for field in ["p_chat_enabled", "p_task_enabled", "p_sound_enabled"] {
                guard let value = p[field] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw failure("invalid_args") }
            }
        case "mobile_push_revoke":
            guard Set(p.keys) == ["p_installation_id", "p_registration_id", "p_generation"],
                  canonicalUUID(p["p_registration_id"]), canonicalUUID(p["p_generation"]) else { throw failure("invalid_args") }
        case "mobile_push_close_installation":
            guard Set(p.keys) == ["p_installation_id", "p_device_id", "p_original_session_id"],
                  p["p_device_id"] as? String == binding.deviceId,
                  canonicalUUID(p["p_original_session_id"]) else { throw failure("invalid_args") }
        default: throw failure("unsupported_rpc")
        }
    }

    private static func canonicalUUID(_ value: Any?) -> Bool {
        guard let string = value as? String else { return false }
        return UUID(uuidString: string)?.uuidString.lowercased() == string
    }
    private static func failure(_ code: String) -> GuguHostFailure {
        GuguHostFailure(code: code, message: "Native notification request was not confirmed")
    }
}
