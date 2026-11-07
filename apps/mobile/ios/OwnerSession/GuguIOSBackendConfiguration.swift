import Foundation

struct GuguIOSBackendConfiguration: Decodable {
    let version: Int
    let supabaseUrl: String
    let anonKey: String

    func baseURL() throws -> URL {
        guard version == 1, let url = URL(string: supabaseUrl), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              !anonKey.isEmpty, anonKey.utf8.count <= 16384,
              !anonKey.contains("\r"), !anonKey.contains("\n") else { throw Self.invalid() }
        return url
    }

    static func load(bundle: Bundle = .main) throws -> GuguIOSBackendConfiguration {
        guard let path = bundle.url(forResource: "GuguBackend", withExtension: "json") else { throw invalid() }
        let bytes = try Data(contentsOf: path)
        guard bytes.count <= 32768 else { throw invalid() }
        let configuration = try JSONDecoder().decode(Self.self, from: bytes)
        _ = try configuration.baseURL()
        return configuration
    }

    private static func invalid() -> GuguHostFailure {
        GuguHostFailure(code: "backend_not_configured", message: "Packaged iOS backend configuration is missing or invalid")
    }
}
