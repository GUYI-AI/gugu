import Foundation
import Security
import LocalAuthentication

/// Dedicated namespace; never searches, deletes or changes another service.
final class GuguIOSClosureKeychain: GuguIOSClosureSecrets {
    private let service: String
    init(bundleIdentifier: String) { service = bundleIdentifier + ".account-closure" }
    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: key, kSecAttrSynchronizable as String: false]
    }
    func read(_ key: String) throws -> Data? {
        var q = query(key); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        let context = LAContext(); context.interactionNotAllowed = true
        q[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw GuguIOSAccountClosure.failure("closure_storage_unavailable") }
        return data
    }
    func write(_ key: String, data: Data) throws {
        let attrs: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query(key) as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query(key).merging(attrs) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw GuguIOSAccountClosure.failure("closure_storage_unavailable") }
    }
}
