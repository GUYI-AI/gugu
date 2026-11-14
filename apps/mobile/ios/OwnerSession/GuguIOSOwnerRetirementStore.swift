import Foundation
import CryptoKit
import Darwin

/// Original cleanup custody. No token, cloud request or task journal is
/// stored here. Opening this store never starts cleanup or interrupts a task.
final class GuguIOSOwnerRetirementStore {
    struct Target: Codable, Equatable {
        let ownerId: String?
        let accessSHA256: String?

        init(ownerId: String?, accessToken: String?) throws {
            guard (ownerId == nil && accessToken == nil) ||
                    (ownerId.flatMap(UUID.init(uuidString:)) != nil && accessToken?.isEmpty == false) else {
                throw GuguIOSOwnerRetirementStore.failure()
            }
            self.ownerId = ownerId
            accessSHA256 = accessToken.map(GuguIOSOwnerRetirementStore.digest)
        }

        func matches(_ stored: GuguIOSStoredSession?) -> Bool {
            ownerId == stored?.ownerId && accessSHA256 == stored.map { GuguIOSOwnerRetirementStore.digest($0.accessToken) }
        }
    }

    struct Original: Codable, Equatable {
        let binding: GuguIOSHostBinding
        let sessionId: String
        let accessSHA256: String
    }

    struct Record: Codable, Equatable {
        let version: Int
        let id: String
        var target: Target
        var captureComplete: Bool
        var original: Original?
        var cleanupComplete: Bool
        // Missing in older records means credential-write retirement.
        var publicationOnly: Bool?
        var isPublicationOnly: Bool { publicationOnly == true }
    }

    private let path: URL
    private let lock = NSRecursiveLock()

    init(directory: URL) {
        path = directory.appendingPathComponent("owner-retirement.json")
    }

    func snapshot() throws -> Record? { try transaction { try read() } }

    /// Save intent before any fallible read of the old credential envelope.
    func begin(target: Target, publicationOnly: Bool = false) throws -> Record {
        try transaction {
            if var prior = try read() {
                // A refresh/write must finish a pending ordinary stop first. It
                // cannot silently turn that stop into a permanent push close.
                guard prior.isPublicationOnly == publicationOnly else { throw Self.failure() }
                // A new explicit storage intent may change the eventual write,
                // while retaining the same old cleanup custody and transaction.
                // Outstanding permits compare the exact target before mutation.
                if prior.target != target { prior.target = target; try write(prior) }
                return prior
            }
            let value = Record(version: 1, id: UUID().uuidString.lowercased(), target: target,
                               captureComplete: false, original: nil, cleanupComplete: false,
                               publicationOnly: publicationOnly ? true : nil)
            try write(value)
            return value
        }
    }

    func capture(id: String, original: Original?) throws -> Record {
        try transaction {
            guard var value = try read(), value.id == id else { throw Self.failure() }
            if value.captureComplete {
                guard value.original == original else { throw Self.failure() }
            } else {
                value.captureComplete = true; value.original = original
                try write(value)
            }
            return value
        }
    }

    func markCleanupComplete(id: String) throws {
        try transaction {
            guard var value = try read(), value.id == id, value.captureComplete else { throw Self.failure() }
            value.cleanupComplete = true
            try write(value)
        }
    }

    /// The lock spans both custody validation and the actual synchronous Keychain
    /// mutation/readback. A competing process cannot retarget between those steps.
    func commit(id: String?, target: Target, persist: () throws -> GuguIOSStoredSession?) throws {
        try transaction {
            if let id {
                guard let value = try read(), value.id == id, value.cleanupComplete,
                      value.captureComplete, !value.isPublicationOnly,
                      value.target == target else { throw Self.failure() }
            } else {
                guard try read() == nil else { throw Self.failure() }
            }
            let stored = try persist()
            guard target.matches(stored) else {
                throw GuguHostFailure(code: "auth_storage_invalid", message: "Native login write differs from its prepared target")
            }
            if id != nil {
                try FileManager.default.removeItem(at: path)
                try syncDirectory()
            }
        }
    }

    /// A crash after the verified cleanup and exact Keychain commit needs no new
    /// remote mutation. An incomplete cleanup or a different token stays sealed.
    @discardableResult func recoverCommittedWrite(stored: GuguIOSStoredSession?) throws -> Bool {
        try transaction {
            guard let value = try read(), !value.isPublicationOnly, value.cleanupComplete, value.captureComplete,
                  value.target.matches(stored) else { return false }
            try FileManager.default.removeItem(at: path)
            try syncDirectory()
            return true
        }
    }

    /// Ordinary publication stop leaves the saved Auth session untouched. Only
    /// its exact completed cleanup can release this separate custody record.
    func finishPublicationStop(id: String, stored: GuguIOSStoredSession?) throws {
        try transaction {
            guard let value = try read(), value.id == id, value.isPublicationOnly,
                  value.captureComplete, value.cleanupComplete,
                  value.target.matches(stored) else { throw Self.failure() }
            try FileManager.default.removeItem(at: path)
            try syncDirectory()
        }
    }

    static func digest(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func transaction<T>(_ work: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        let directory = path.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        var protected = directory, flags = URLResourceValues(); flags.isExcludedFromBackup = true
        try protected.setResourceValues(flags)
        let fd = open(path.path + ".lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        while flock(fd, LOCK_EX) != 0 {
            guard errno == EINTR else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
        defer { flock(fd, LOCK_UN) }
        return try work()
    }

    private func read() throws -> Record? {
        // A directory, dangling symlink or malformed file is a closed barrier.
        var info = stat()
        guard lstat(path.path, &info) == 0 else {
            if errno == ENOENT { return nil }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= 65536 else { throw Self.failure() }
        let value = try JSONDecoder().decode(Record.self, from: Data(contentsOf: path))
        guard value.version == 1, Self.uuid(value.id),
              (value.target.ownerId == nil && value.target.accessSHA256 == nil) ||
                (value.target.ownerId.map(Self.uuid) == true && value.target.accessSHA256.map(Self.hash) == true),
              value.captureComplete || (value.original == nil && !value.cleanupComplete) else { throw Self.failure() }
        if let original = value.original {
            try original.binding.validate()
            guard Self.uuid(original.sessionId), Self.hash(original.accessSHA256) else { throw Self.failure() }
        }
        return value
    }

    private func write(_ value: Record) throws {
        let bytes = try JSONEncoder().encode(value)
        #if os(iOS)
        try bytes.write(to: path, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: path, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        let file = try FileHandle(forWritingTo: path)
        try file.synchronize(); try file.close()
        try syncDirectory()
    }

    private func syncDirectory() throws {
        let fd = open(path.deletingLastPathComponent().path, O_RDONLY | O_CLOEXEC)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }
    private static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    private static func hash(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    private static func failure() -> GuguHostFailure {
        .init(code: "retirement_pending", message: "Original credential retirement remains unresolved")
    }
}
