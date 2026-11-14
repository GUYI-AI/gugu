import Foundation

struct GuguIOSHostBinding: Codable, Equatable {
    let ownerId: String
    let deviceId: String
    let installationId: String

    func validate() throws {
        guard UUID(uuidString: ownerId) != nil, UUID(uuidString: installationId) != nil,
              deviceId == "phone-\(installationId)-\(ownerId)" else {
            throw GuguHostFailure(code: "stale_context", message: "Native phone binding does not match owner and installation")
        }
    }
}

/// The Capacitor glue constructs this field-by-field. There is intentionally no
/// access/refresh token field, auth session dictionary or arbitrary endpoint.
struct GuguIOSHostConfiguration {
    let binding: GuguIOSHostBinding
    let grants: [String: Bool]
    let deviceMetadata: [String: Any]
}

enum GuguIOSHostCallOrigin {
    case localOwnerUI
    case remoteAgent
}

struct GuguIOSHostInvocation {
    let binding: GuguIOSHostBinding
    let requestId: String
    let channel: String
    let arguments: [Any]
    let origin: GuguIOSHostCallOrigin
}

/// Implementations must reconcile their durable per-phase IDs before resuming an
/// uncertain mutation. This is an injected real service, not a success fallback.
protocol GuguIOSHostBackend: AnyObject {
    func configure(_ configuration: GuguIOSHostConfiguration, completion: @escaping ([String: Any]) -> Void)
    func state(binding: GuguIOSHostBinding) throws -> [String: Any]
    func invoke(_ call: GuguIOSHostInvocation, completion: @escaping ([String: Any]) -> Void)
    func authorizeReplay(_ call: GuguIOSHostInvocation) throws
    func reconcile(_ call: GuguIOSHostInvocation, completion: @escaping ([String: Any]) -> Void)
    func stop(binding: GuguIOSHostBinding, completion: @escaping (Error?) -> Void)
}
