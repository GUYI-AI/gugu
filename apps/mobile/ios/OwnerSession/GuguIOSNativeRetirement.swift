import Foundation

extension GuguIOSOwnerSession {
    /// Only the separate cleanup transport accepts this four-operation value.
    /// Ordinary catalog/issue/renew/hostCall keep their original provider.
    func retirementAuthorization(expectedBinding: GuguIOSHostBinding, retirementId: String,
                                 operation: GuguIOSRetirementOperation) throws -> GuguIOSRetirementAuthorization {
        let original = try verifiedRetirementCredentials(expectedBinding: expectedBinding, retirementId: retirementId)
        return try .init(binding: original.binding, retirementId: retirementId, operation: operation,
                         accessToken: original.accessToken, expiresAt: original.expiresAt)
    }
}
