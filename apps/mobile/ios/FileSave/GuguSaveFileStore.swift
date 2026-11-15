import Foundation
import CryptoKit
import UniformTypeIdentifiers

/// Private, bounded staging. Only a committed token can be consumed by a system save UI.
final class GuguSaveFileStore {
    struct Entry { let url: URL; let size: Int64; let sha256: String; let mime: String }
    private struct Pending { let entry: Entry; let handle: FileHandle; var count: Int64 = 0 }
    private let root: URL
    private var pending: [String: Pending] = [:]
    private var verified: [String: Entry] = [:]
    init(root: URL) throws {
        self.root = root
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    enum Kind { case image, video, file }
    enum Destination { case photos, files, complete }
    static func destination(kind: Kind, photosGranted: Bool, photosAccepted: Bool? = nil) -> Destination {
        if kind == .file || !photosGranted { return .files }
        guard let photosAccepted else { return .photos }
        return photosAccepted ? .complete : .files
    }
    static func kind(mime: String, name: String) -> Kind {
        let declared = mime.lowercased().split(separator: ";").first.map(String.init) ?? ""
        let type = (declared.isEmpty || declared == "application/octet-stream")
            ? UTType(filenameExtension: (name as NSString).pathExtension) : UTType(mimeType: declared)
        if type?.conforms(to: .image) == true { return .image }
        if type?.conforms(to: .movie) == true { return .video }
        return .file
    }
    func finish(_ entry: Entry, saved: Bool, error: Error?) throws -> Bool {
        try remove(entry)
        if let error { throw error }
        return saved
    }
    static func failure() -> NSError { NSError(domain: "GuguSaveFile", code: 1, userInfo: [NSLocalizedDescriptionKey: "The file could not be verified or saved."]) }
    func begin(name: String, size: Int64, sha256: String, mime: String) throws -> String {
        guard size >= 0, size <= 9_007_199_254_740_991, sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"), !name.contains("\0") else { throw Self.failure() }
        let id = UUID().uuidString, directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(name)
        do {
            guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw Self.failure() }
            pending[id] = Pending(entry: Entry(url: url, size: size, sha256: sha256, mime: mime), handle: try FileHandle(forWritingTo: url))
            return id
        } catch { try FileManager.default.removeItem(at: directory); throw error }
    }
    func append(id: String, data: Data) throws {
        guard var value = pending[id], data.count <= 524_288, Int64(data.count) <= value.entry.size - value.count else { throw Self.failure() }
        try value.handle.write(contentsOf: data); value.count += Int64(data.count); pending[id] = value
    }
    func commit(id: String) throws {
        guard let value = pending[id] else { throw Self.failure() }
        try value.handle.close(); pending.removeValue(forKey: id)
        do { try verify(value.entry); verified[id] = value.entry }
        catch { try FileManager.default.removeItem(at: value.entry.url.deletingLastPathComponent()); throw error }
    }
    private func verify(_ entry: Entry) throws {
        let handle = try FileHandle(forReadingFrom: entry.url); defer { try? handle.close() }
        var hash = SHA256(), count: Int64 = 0
        while let data = try handle.read(upToCount: 524_288), !data.isEmpty { hash.update(data: data); count += Int64(data.count) }
        guard count == entry.size, hash.finalize().map({ String(format: "%02x", $0) }).joined() == entry.sha256 else { throw Self.failure() }
    }
    func take(id: String) throws -> Entry {
        guard let entry = verified[id] else { throw Self.failure() }
        try verify(entry); verified.removeValue(forKey: id); return entry
    }
    func remove(id: String) throws {
        if let value = pending.removeValue(forKey: id) { try? value.handle.close(); try remove(value.entry) }
        if let entry = verified.removeValue(forKey: id) { try remove(entry) }
    }
    func remove(_ entry: Entry) throws { try FileManager.default.removeItem(at: entry.url.deletingLastPathComponent()) }
}
