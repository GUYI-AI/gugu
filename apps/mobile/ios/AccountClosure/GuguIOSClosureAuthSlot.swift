import Foundation
import Security

/// The existing auth envelope is left untouched unless its owner is precisely
/// the captured closed owner. Every caller holds OwnerSession's commit lock.
final class GuguIOSClosureAuthSlot {
    private let service: String
    init(bundleIdentifier: String) { service = bundleIdentifier + ".auth-storage" }
    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }
    private func bytes(_ key: String) throws -> Data? {
        var q = query(key); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw GuguIOSAccountClosure.failure("closure_storage_unavailable") }
        return data
    }
    func owner() throws -> String? {
        guard let data = try bytes("sb-main"), let value = String(data: data, encoding: .utf8) else { return nil }
        return try GuguIOSOwnerKeychain.ownerForMainWrite(value)
    }
    func eraseMainIfOwned(by ownerId: String) throws {
        guard let data = try bytes("sb-main"), let value = String(data: data, encoding: .utf8),
              let knownOwner = try? GuguIOSOwnerKeychain.ownerForMainWrite(value), knownOwner == ownerId else { return }
        let status = SecItemDelete(query("sb-main") as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw GuguIOSAccountClosure.failure("closure_storage_unavailable") }
    }
    func retainedUnattributed() throws -> [String] {
        var names: [String] = []
        if let data = try bytes("sb-main") {
            if let value = String(data: data, encoding: .utf8) {
                do { _ = try GuguIOSOwnerKeychain.ownerForMainWrite(value) }
                catch { names.append("auth-main-unattributed") }
            } else { names.append("auth-main-unattributed") }
        }
        for (key, name) in [("sb-main-code-verifier", "auth-code-verifier"), ("sb-main-oauth-pending", "auth-oauth-pending")] {
            if try bytes(key) != nil { names.append(name) }
        }
        return names
    }
}
