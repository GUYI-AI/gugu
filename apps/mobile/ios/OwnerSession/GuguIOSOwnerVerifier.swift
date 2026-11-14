import Foundation

private final class GuguOwnerRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// An ordinary authenticated getUser request. It neither restores nor refreshes a
/// session and never sends credentials to a renderer-selected URL or a redirect.
final class GuguIOSOwnerVerifier {
    private struct User: Decodable { let id: String }
    private let configuration: GuguIOSBackendConfiguration
    private let delegate = GuguOwnerRedirectDelegate()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 20
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }()

    init(configuration: GuguIOSBackendConfiguration) throws {
        _ = try configuration.baseURL()
        self.configuration = configuration
    }

    func verify(accessToken: String, completion: @escaping (Result<String, Error>) -> Void) {
        do {
            let url = try configuration.baseURL().appendingPathComponent("auth/v1/user")
            guard !accessToken.isEmpty, !accessToken.contains("\r"), !accessToken.contains("\n") else { throw failure() }
            var request = URLRequest(url: url, timeoutInterval: 15)
            request.httpMethod = "GET"
            request.setValue(configuration.anonKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
            session.dataTask(with: request) { bytes, response, error in
                guard error == nil, let response = response as? HTTPURLResponse,
                      response.statusCode == 200, let bytes, bytes.count <= 1048576,
                      let user = try? JSONDecoder().decode(User.self, from: bytes),
                      UUID(uuidString: user.id)?.uuidString.lowercased() == user.id else {
                    completion(.failure(self.failure())); return
                }
                completion(.success(user.id))
            }.resume()
        } catch { completion(.failure(error)) }
    }

    private func failure() -> GuguHostFailure { GuguHostFailure(code: "auth_check_failed", message: "Cannot verify the current native login") }
    deinit { session.invalidateAndCancel() }
}
