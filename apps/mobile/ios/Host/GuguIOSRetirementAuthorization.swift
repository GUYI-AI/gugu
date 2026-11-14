import Foundation

enum GuguIOSRetirementOperation: Equatable {
    case checkpointLease(String)
    case revokeLease(String)
    case readOwnedDevice
    case withdrawOwnedDevice
}

/// Separate from ordinary owner credentials. Only this source reads its token.
/// It is never Codable, a bridge result, or a reusable general broker ticket.
struct GuguIOSRetirementAuthorization: CustomDebugStringConvertible, CustomStringConvertible {
    let binding: GuguIOSHostBinding
    let retirementId: String
    let operation: GuguIOSRetirementOperation
    let expiresAt: Date
    fileprivate let accessToken: String
    var debugDescription: String { "GuguIOSRetirementAuthorization(<redacted>)" }
    var description: String { debugDescription }

    init(binding: GuguIOSHostBinding, retirementId: String, operation: GuguIOSRetirementOperation, accessToken: String, expiresAt: Date) throws {
        try binding.validate()
        guard UUID(uuidString: retirementId) != nil, !accessToken.isEmpty, !accessToken.contains("\r"), !accessToken.contains("\n"),
              expiresAt > Date(), expiresAt.timeIntervalSinceNow <= 300 else { throw GuguHostFailure(code: "retirement_not_authorized", message: "Native retirement permit is invalid or expired") }
        self.binding = binding; self.retirementId = retirementId; self.operation = operation; self.accessToken = accessToken; self.expiresAt = expiresAt
    }
}

private final class GuguIOSRetirementRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Private fixed-operation HTTP path. It never supplies ordinary credentials or
/// accepts an arbitrary path/body. The durable retirement plan selects all IDs.
final class GuguIOSRetirementHTTP {
    private let root: URL, anonKey: String
    private let store: GuguIOSBackendStore
    private let retirementId: String
    private let authorize: GuguIOSRetirementCleanup.Authorize
    private let send: GuguIOSCloudBroker.Send
    private let session: URLSession?
    private let redirects: GuguIOSRetirementRedirects?

    init(configuration: GuguIOSBackendConfiguration, store: GuguIOSBackendStore, retirementId: String,
         authorize: @escaping GuguIOSRetirementCleanup.Authorize, send: GuguIOSCloudBroker.Send?) throws {
        root = try configuration.baseURL(); anonKey = configuration.anonKey; self.store = store; self.retirementId = retirementId; self.authorize = authorize
        if let send { self.send = send; session = nil; redirects = nil }
        else {
            let redirects = GuguIOSRetirementRedirects(), configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 45
            let session = URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
            self.session = session; self.redirects = redirects
            self.send = { request, done in session.dataTask(with: request, completionHandler: done).resume() }
        }
    }

    static func permit(_ authorize: GuguIOSRetirementCleanup.Authorize, binding: GuguIOSHostBinding, retirementId: String,
                       operation: GuguIOSRetirementOperation) throws -> GuguIOSRetirementAuthorization {
        let value = try authorize(binding, retirementId, operation)
        guard value.binding == binding, value.retirementId == retirementId, value.operation == operation,
              value.expiresAt > Date(), value.expiresAt.timeIntervalSinceNow <= 300 else {
            throw failure("retirement_not_authorized", "Retirement permit differs from the original cleanup scope")
        }
        return value
    }

    func perform(_ operation: GuguIOSRetirementOperation, known: @escaping (Any) throws -> Void = { _ in },
                 completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            let binding = store.binding, ticket = try Self.permit(authorize, binding: binding, retirementId: retirementId, operation: operation)
            guard let pointer = try store.record("requests", id: "native-retirement"), pointer["retirementId"] as? String == retirementId,
                  let plan = try store.record("requests", id: "retirement:\(retirementId)") else { throw Self.failure("stale_context", "Original retirement transaction is unavailable") }
            var path = "functions/v1/model-access", method = "POST", schema: String?, body: [String: Any]?, query: [URLQueryItem] = []
            switch operation {
            case .checkpointLease(let lease), .revokeLease(let lease):
                guard UUID(uuidString: lease) != nil, let entries = plan["leases"] as? [[String: String]],
                      let entry = entries.first(where: { $0["leaseId"] == lease }), let key = entry["key"],
                      try store.record("leases", id: key)?["leaseId"] as? String == lease else { throw Self.failure("retirement_not_authorized", "Lease is not in the original retirement ledger") }
                let action: String
                if case .checkpointLease = operation { action = "checkpoint" } else { action = "revoke" }
                body = ["action": action, "session_id": lease]
            case .readOwnedDevice:
                path = "rest/v1/gugu_devices"; method = "GET"; schema = "identity"
                query = [.init(name: "select", value: "device_id,user_id,capabilities,updated_at"), .init(name: "device_id", value: "eq.\(binding.deviceId)"), .init(name: "user_id", value: "eq.\(binding.ownerId)")]
            case .withdrawOwnedDevice:
                guard let device = plan["deviceCAS"] as? [String: Any], let before = device["before"] as? String,
                      let after = device["after"] as? String, let original = device["originalCapabilities"] as? [String: Any], let capabilities = device["capabilities"] as? [String: Any],
                      capabilities["host_kind"] as? String == "phone", (capabilities["runtimes"] as? [String])?.isEmpty == true,
                      capabilities["host_runtime_capability"] as? Int == 0 else { throw Self.failure("retirement_not_authorized", "Original device withdrawal CAS is unavailable") }
                var wanted = original; wanted["runtimes"] = []; wanted["host_runtime_capability"] = 0
                guard try GuguHostJournal.digest(wanted) == GuguHostJournal.digest(capabilities) else { throw Self.failure("invalid_journal", "Device cleanup would change unrelated capabilities") }
                path = "rest/v1/gugu_devices"; method = "PATCH"; schema = "identity"
                query = [.init(name: "device_id", value: "eq.\(binding.deviceId)"), .init(name: "user_id", value: "eq.\(binding.ownerId)"), .init(name: "updated_at", value: "eq.\(before)"), .init(name: "select", value: "device_id")]
                body = ["capabilities": capabilities, "updated_at": after]
            }
            try GuguIOSCloudBroker.rejectCredentials(body)
            var components = URLComponents(url: root.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
            if !query.isEmpty { components.queryItems = query }
            guard let url = components.url else { throw Self.failure("invalid_args", "Cannot encode native retirement request") }
            var request = URLRequest(url: url, timeoutInterval: 30); request.httpMethod = method
            request.setValue(anonKey, forHTTPHeaderField: "apikey"); request.setValue("Bearer \(ticket.accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let schema { request.setValue(schema, forHTTPHeaderField: method == "GET" ? "Accept-Profile" : "Content-Profile") }
            if method == "PATCH" { request.setValue("return=representation", forHTTPHeaderField: "Prefer") }
            if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes]) }
            send(request) { bytes, response, error in
                do {
                    guard error == nil else { throw Self.failure("cleanup_transport_uncertain", "Native retirement request returned no known result") }
                    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw Self.failure("cleanup_http_error", "Retirement HTTP status \((response as? HTTPURLResponse)?.statusCode ?? 0)") }
                    let value: Any
                    if let bytes, !bytes.isEmpty {
                        guard let parsed = try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]) else { throw Self.failure("cleanup_protocol_error", "Native retirement response is not valid JSON") }
                        value = parsed
                    } else { value = NSNull() }
                    // A known write belongs to the old transaction even when its
                    // authority is revoked before the post-response check.
                    try known(value)
                    let current = try Self.permit(self.authorize, binding: binding, retirementId: self.retirementId, operation: operation)
                    guard current.accessToken == ticket.accessToken, current.expiresAt == ticket.expiresAt else { throw Self.failure("stale_context", "Retirement authorization changed during cleanup") }
                    completion(.success(value))
                } catch { completion(.failure(error)) }
            }
        } catch { completion(.failure(error)) }
    }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { .init(code: code, message: text) }
    deinit { session?.invalidateAndCancel() }
}
