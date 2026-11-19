import Foundation

struct GuguIOSClosureV2Policy: Decodable {
    let protocol_version: Int
    let available: Bool
    let deletion: String
    let credit_treatment: String
    let consent_version: String
    let device_preparation_required: Bool
    static func decode(_ reply: GuguIOSClosureV2HTTP.Reply) throws -> Self {
        struct Envelope: Decodable { let policy: GuguIOSClosureV2Policy }
        try reply.requireSuccess()
        guard reply.status == 200, let root = try? JSONSerialization.jsonObject(with: reply.bytes) as? [String: Any],
              let raw = root["policy"] as? [String: Any], raw.count == 6,
              let policy = try? JSONDecoder().decode(Envelope.self, from: reply.bytes).policy,
              policy.protocol_version == 2, policy.deletion == "immediate", policy.credit_treatment == "forfeit_remaining",
              policy.consent_version == "immediate-forfeit-v1", policy.device_preparation_required else {
            throw GuguIOSClosureV2Operation.failure("closure_unavailable")
        }
        return policy
    }
    var snapshot: [String: Any] {
        ["protocol_version": 2, "available": available, "deletion": "immediate", "credit_treatment": "forfeit_remaining",
         "consent_version": "immediate-forfeit-v1", "device_preparation_required": true]
    }
}

/// One bounded exchange owns its session/delegate. No redirect, cache or automatic application retry.
private final class GuguIOSClosureV2Exchange: NSObject, URLSessionDataDelegate {
    private let request: URLRequest
    private let completion: (Result<GuguIOSClosureV2HTTP.Reply, Error>) -> Void
    private var session: URLSession?
    private var bytes = Data()
    private var status: Int?
    private var refused = false
    init(request: URLRequest, completion: @escaping (Result<GuguIOSClosureV2HTTP.Reply, Error>) -> Void) {
        self.request = request; self.completion = completion
    }
    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 20
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        self.session = session; session.dataTask(with: request).resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        refused = true; completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, !(300..<400).contains(http.statusCode),
              response.mimeType?.lowercased() == "application/json", response.expectedContentLength <= 65536 else {
            refused = true; completionHandler(.cancel); return
        }
        status = http.statusCode; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard bytes.count + data.count <= 65536 else { refused = true; dataTask.cancel(); return }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { session.finishTasksAndInvalidate(); self.session = nil }
        guard error == nil, !refused, let status, String(data: bytes, encoding: .utf8) != nil else {
            completion(.failure(GuguIOSClosureV2Operation.failure("closure_unavailable"))); return
        }
        completion(.success(.init(status: status, bytes: bytes)))
    }
}

final class GuguIOSClosureV2HTTP {
    struct Reply {
        let status: Int
        let bytes: Data
        var cancellationBlocked: Bool {
            if status == 409 { return true }
            return (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any])?["error"] as? String == "request_active"
        }
        func requireSuccess(allowDefinitiveRejection: Bool = false) throws {
            if [200, 201, 202].contains(status) || (allowDefinitiveRejection && status == 422) { return }
            let value = (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any])?["error"] as? String
            let codes: Set<String> = ["unauthorized", "invalid_request", "verification_failed", "rate_limited", "operation_busy",
                "request_active", "state_conflict", "not_found", "preparation_unavailable", "outcome_unknown", "email_outcome_unknown", "scope_conflict"]
            throw GuguIOSClosureV2Operation.failure(value.map { codes.contains($0) ? $0 : "closure_unavailable" } ?? "closure_unavailable")
        }
    }
    typealias Send = (URLRequest, @escaping (Result<Reply, Error>) -> Void) -> Void
    private let base: URL
    private let anonKey: String
    private let send: Send
    private static let routes: Set<String> = ["status", "register", "challenge", "prepare_device", "read_preparation", "cancel_preparation", "confirm", "cancel", "result"]
    var backendIdentity: String { base.absoluteString }
    init(configuration: GuguIOSBackendConfiguration, send: Send? = nil) throws {
        base = try configuration.baseURL(); anonKey = configuration.anonKey
        guard Self.publicKey(anonKey) else { throw GuguIOSClosureV2Operation.failure("closure_unavailable") }
        self.send = send ?? { request, completion in GuguIOSClosureV2Exchange(request: request, completion: completion).start() }
    }
    func request(route: String, bearer: String?, body: [String: Any]?, completion: @escaping (Result<Reply, Error>) -> Void) {
        do { send(try specification(route: route, bearer: bearer, body: body), completion) }
        catch { completion(.failure(GuguIOSClosureV2Operation.failure("closure_unavailable"))) }
    }
    /// Native only; a renderer never supplies the route, backend, body or bearer.
    func specification(route: String, bearer: String?, body: [String: Any]?) throws -> URLRequest {
        let policy = route == "status"
        guard Self.routes.contains(route), policy ? body == nil : body != nil,
              route == "result" || bearer != nil else { throw GuguIOSClosureV2Operation.failure("invalid_request") }
        if let bearer {
            guard !bearer.isEmpty, bearer.utf8.count <= 8192, bearer.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else {
                throw GuguIOSClosureV2Operation.failure("unauthorized")
            }
        }
        var request = URLRequest(url: base.appendingPathComponent("functions/v1/account-deletion/v2/" + route), timeoutInterval: 15)
        request.httpMethod = policy ? "GET" : "POST"
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        if let body {
            let data = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
            guard data.count <= 4096 else { throw GuguIOSClosureV2Operation.failure("invalid_request") }
            request.httpBody = data; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }
    private static func publicKey(_ key: String) -> Bool {
        if key.hasPrefix("sb_publishable_") { return true }
        let parts = key.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return false }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload), let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return claims["role"] as? String == "anon"
    }
}
