import Foundation

/// An install identity is kept in the app container, excluded from backup. It is
/// deliberately not in Keychain, which may survive uninstalling the application.
final class GuguIOSInstallation {
    private let lock = NSLock()
    private let directory: URL
    // Resolve the native container's platform aliases (for example /var on iOS)
    // once. Later path substitutions must still match this trusted anchor.
    init(directory: URL) { self.directory = directory.standardizedFileURL.resolvingSymlinksInPath() }

    func identifier() throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard directory.isFileURL, directory.resolvingSymlinksInPath() == directory else { throw invalid() }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        var root = directory, values = URLResourceValues(); values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        let path = directory.appendingPathComponent("installation.json")
        if FileManager.default.fileExists(atPath: path.path) {
            let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let length = attributes[.size] as? NSNumber, length.intValue <= 256,
                  path.resolvingSymlinksInPath() == path,
                  let record = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any],
                  record["version"] as? Int == 1, let id = record["id"] as? String,
                  UUID(uuidString: id)?.uuidString.lowercased() == id else { throw invalid() }
            return id
        }
        let id = UUID().uuidString.lowercased()
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "id": id], options: [.sortedKeys])
        #if os(iOS)
        try bytes.write(to: path, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: path, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let handle = try FileHandle(forWritingTo: path); try handle.synchronize(); try handle.close()
        return id
    }

    private func invalid() -> GuguHostFailure { GuguHostFailure(code: "installation_unavailable", message: "Cannot verify this native installation") }
}
