import Foundation
import CoreFoundation

/// Only these selected facts may leave the native HTTP failure parser. They are
/// not added to the Pi/JSC reply or automatically persisted in any journal.
struct GuguModelHTTPDiagnostic: Equatable {
    let status: Int
    let serverErrorCode: String?
    let requestId: String?
    var fields: [String: Any] {
        var value: [String: Any] = ["status": status]
        if let serverErrorCode { value["serverErrorCode"] = serverErrorCode }
        if let requestId { value["requestId"] = requestId }
        return value
    }
}

protocol GuguModelHTTPTask: AnyObject {
    func resume()
    func cancel()
}
extension URLSessionDataTask: GuguModelHTTPTask {}

protocol GuguModelCompleting: AnyObject {
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void)
    func cancel(id: String)
}

/// Native-only, ephemeral model lease. Never Codable, persisted, logged or sent to JSC.
struct GuguNativeModelLease {
    let ownerId: String
    let agentUserId: String
    let sessionId: String
    let modelId: String
    let completionsURL: URL
    let bearerToken: String
    let expiresAt: Date
}

/// No automatic retry or redirect: the authenticated lease selects the endpoint
/// and model. JavaScript supplies only a protocol body, never a URL or credential.
private final class GuguModelRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class GuguModelTransport: NSObject, GuguModelCompleting {
    typealias Send = (URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> GuguModelHTTPTask
    typealias Diagnostic = (GuguModelHTTPDiagnostic) -> Void
    private let redirects = GuguModelRedirectDelegate()
    private let lease: GuguNativeModelLease
    private let lock = NSLock()
    private var tasks: [String: GuguModelHTTPTask] = [:]
    private let send: Send?
    private let diagnostic: Diagnostic?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
    }()

    init(lease: GuguNativeModelLease, diagnostic: Diagnostic? = nil, send: Send? = nil) throws {
        guard lease.completionsURL.scheme == "https", lease.completionsURL.host != nil,
              lease.completionsURL.user == nil, lease.completionsURL.password == nil,
              lease.completionsURL.query == nil, lease.completionsURL.fragment == nil,
              !lease.bearerToken.isEmpty, lease.expiresAt > Date() else {
            throw GuguHostFailure(code: "invalid_model_lease", message: "Native model lease is invalid or expired")
        }
        self.lease = lease
        self.diagnostic = diagnostic; self.send = send
    }

    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        do {
            guard context.ownerId == lease.ownerId, context.agentUserId == lease.agentUserId,
                  context.sessionId == lease.sessionId, body["model"] as? String == lease.modelId,
                  body["stream"] as? Bool == false, lease.expiresAt > Date() else {
                throw GuguHostFailure(code: "model_lease_mismatch", message: "Model lease does not authorize this task or request")
            }
            var request = URLRequest(url: lease.completionsURL, timeoutInterval: 120)
            request.httpMethod = "POST"
            request.setValue("Bearer \(lease.bearerToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let receive: (Data?, URLResponse?, Error?) -> Void = { [weak self] bytes, response, error in
                if let self { self.lock.lock(); self.tasks.removeValue(forKey: id); self.lock.unlock() }
                if let error {
                    completion(GuguHostFailure(code: (error as NSError).code == NSURLErrorCancelled ? "cancelled" : "model_transport_failed", message: error.localizedDescription).envelope)
                    return
                }
                guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), let bytes else {
                    if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                        self?.reportHTTPFailure(response, bytes: bytes)
                    }
                    completion(GuguHostFailure(code: "model_http_error", message: "Model HTTP status \((response as? HTTPURLResponse)?.statusCode ?? 0)").envelope)
                    return
                }
                do {
                    guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                        throw GuguHostFailure(code: "model_protocol_error", message: "Model response is not an object")
                    }
                    completion(["ok": true, "data": object])
                } catch { completion(GuguHostFailure(code: "model_protocol_error", message: "Model response is not valid JSON").envelope) }
            }
            let task: GuguModelHTTPTask
            if let send { task = send(request, receive) }
            else { task = session.dataTask(with: request, completionHandler: receive) }
            lock.lock()
            guard tasks[id] == nil else { lock.unlock(); completion(GuguHostFailure(code: "duplicate_conflict", message: "Model request ID is already active").envelope); return }
            tasks[id] = task
            lock.unlock()
            task.resume()
        } catch let error as GuguHostFailure { completion(error.envelope) }
        catch { completion(GuguHostFailure(code: "invalid_args", message: "Cannot encode model request").envelope) }
    }

    func cancel(id: String) {
        lock.lock(); let task = tasks[id]; lock.unlock()
        task?.cancel()
    }

    private func reportHTTPFailure(_ response: HTTPURLResponse, bytes: Data?) {
        guard let diagnostic else { return }
        var body: [String: Any]?
        // Parse only a bounded structured error; never expose its message, raw
        // bytes, headers, URL or reflected request/credential to the observer.
        if let bytes, bytes.count <= 65536 { body = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] }
        let error = body?["error"] as? [String: Any]
        let codes: [Any?] = [error?["code"], body?["error_code"], body?["code"], error?["type"]]
        let code = codes.compactMap { scalar($0) }.compactMap { safeField($0, requestId: false) }.first
        let headers = ["x-request-id", "request-id", "x-amzn-requestid", "cf-ray"]
        let ids: [String] = headers.compactMap { response.value(forHTTPHeaderField: $0) } + [body?["request_id"] as? String, error?["request_id"] as? String].compactMap { $0 }
        let requestId = ids.compactMap { safeField($0, requestId: true) }.first
        diagnostic(.init(status: response.statusCode, serverErrorCode: code, requestId: requestId))
    }
    private func scalar(_ value: Any?) -> String? {
        if let string = value as? String { return string }
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
           number.stringValue.range(of: "^[0-9]{1,9}$", options: .regularExpression) != nil { return number.stringValue }
        return nil
    }
    private func safeField(_ value: String, requestId: Bool) -> String? {
        let pattern = requestId ? "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$" : "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$"
        guard value.range(of: pattern, options: .regularExpression) != nil,
              value.range(of: lease.bearerToken, options: .caseInsensitive) == nil,
              !value.hasPrefix("eyJ"), !value.lowercased().hasPrefix("sk-"),
              lease.completionsURL.host.map({ value.range(of: $0, options: .caseInsensitive) == nil }) == true else { return nil }
        return value
    }

    deinit { session.invalidateAndCancel() }
}
