import Foundation

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
    private let redirects = GuguModelRedirectDelegate()
    private let lease: GuguNativeModelLease
    private let lock = NSLock()
    private var tasks: [String: URLSessionDataTask] = [:]
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: redirects, delegateQueue: nil)
    }()

    init(lease: GuguNativeModelLease) throws {
        guard lease.completionsURL.scheme == "https", lease.completionsURL.host != nil,
              lease.completionsURL.user == nil, lease.completionsURL.password == nil,
              lease.completionsURL.query == nil, lease.completionsURL.fragment == nil,
              !lease.bearerToken.isEmpty, lease.expiresAt > Date() else {
            throw GuguHostFailure(code: "invalid_model_lease", message: "Native model lease is invalid or expired")
        }
        self.lease = lease
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
            let task = session.dataTask(with: request) { [weak self] bytes, response, error in
                if let self { self.lock.lock(); self.tasks.removeValue(forKey: id); self.lock.unlock() }
                if let error {
                    completion(GuguHostFailure(code: (error as NSError).code == NSURLErrorCancelled ? "cancelled" : "model_transport_failed", message: error.localizedDescription).envelope)
                    return
                }
                guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), let bytes else {
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

    deinit { session.invalidateAndCancel() }
}
