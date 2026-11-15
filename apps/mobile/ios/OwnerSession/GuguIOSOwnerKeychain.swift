import Foundation
import Security

/// Reads the same main envelope used by GuguAuthStorage. No refresh-token field
/// exists in these decoding projections or the returned value.
final class GuguIOSOwnerKeychain {
    private struct Envelope: Decodable { let state: String; let raw: String? }
    private struct User: Decodable { let id: String }
    private struct MainSession: Decodable { let user: User; let access_token: String; let expires_at: Double? }
    private struct Claims: Decodable { let sub: String; let exp: Double }
    private struct Identity: Decodable { let user: User }
    private let service: String
    init(bundleIdentifier: String) { service = bundleIdentifier + ".auth-storage" }

    func read() throws -> GuguIOSStoredSession? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "sb-main",
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = value as? Data else {
            throw GuguHostFailure(code: "auth_storage_unavailable", message: "Native login storage is unavailable (\(status))")
        }
        return try Self.decode(bytes)
    }

    static func ownerForMainWrite(_ value: String) throws -> String? {
        let envelope = try envelope(Data(value.utf8))
        if envelope.state == "RETIRED_EMPTY" { return nil }
        guard envelope.state == "SESSION", let raw = envelope.raw,
              let owner = try? JSONDecoder().decode(Identity.self, from: Data(raw.utf8)).user.id,
              canonicalUUID(owner) else { throw invalid() }
        return owner
    }

    static func decode(_ bytes: Data) throws -> GuguIOSStoredSession? {
        let envelope = try envelope(bytes)
        if envelope.state == "RETIRED_EMPTY" { return nil }
        guard envelope.state == "SESSION", let raw = envelope.raw,
              let session = try? JSONDecoder().decode(MainSession.self, from: Data(raw.utf8)),
              canonicalUUID(session.user.id), !session.access_token.isEmpty,
              session.access_token.utf8.count <= 65536 else { throw invalid() }
        let parts = session.access_token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { throw invalid() }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONDecoder().decode(Claims.self, from: data),
              claims.sub == session.user.id, claims.exp.isFinite, claims.exp > 0 else { throw invalid() }
        let expiry = min(session.expires_at ?? claims.exp, claims.exp)
        guard expiry.isFinite, expiry > 0 else { throw invalid() }
        // Decoding claims is not verification. GuguIOSOwnerSession additionally
        // requires the real backend's auth.getUser before it publishes identity.
        return GuguIOSStoredSession(ownerId: session.user.id, accessToken: session.access_token, expiresAt: Date(timeIntervalSince1970: expiry))
    }

    private static func envelope(_ data: Data) throws -> Envelope {
        guard data.count <= 1048576,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { throw invalid() }
        let expected: Set<String> = envelope.state == "RETIRED_EMPTY" ? ["state"] : ["state", "raw"]
        guard Set(object.keys) == expected else { throw invalid() }
        return envelope
    }
    private static func canonicalUUID(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    private static func invalid() -> GuguHostFailure { GuguHostFailure(code: "auth_storage_invalid", message: "Native login envelope is invalid") }
}
