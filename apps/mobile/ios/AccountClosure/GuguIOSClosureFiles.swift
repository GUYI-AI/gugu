import Foundation
import Darwin

/// Fixed owner directories only. Paths and filenames cannot come from JS.
final class GuguIOSClosureFiles {
    static let directories = ["service/backend", "service/host-calls", "host", "categories"]
    private let root: URL
    init(root: URL) { self.root = root.standardizedFileURL.resolvingSymlinksInPath() }
    func erase(ownerId: String, directory: String) throws {
        guard UUID(uuidString: ownerId)?.uuidString.lowercased() == ownerId,
              Self.directories.contains(directory) else { throw GuguIOSAccountClosure.failure("invalid_scope") }
        var rootInfo = stat()
        guard lstat(root.path, &rootInfo) == 0, (rootInfo.st_mode & S_IFMT) == S_IFDIR,
              root.resolvingSymlinksInPath().standardizedFileURL.path == root.path else {
            throw GuguIOSAccountClosure.failure("closure_path_changed")
        }
        var path = root
        for component in directory.split(separator: "/").map(String.init) + [ownerId] {
            path.appendPathComponent(component, isDirectory: true)
            var info = stat()
            if lstat(path.path, &info) != 0 {
                if errno == ENOENT { return }
                throw GuguIOSAccountClosure.failure("closure_files_unavailable")
            }
            guard (info.st_mode & S_IFMT) == S_IFDIR,
                  path.resolvingSymlinksInPath().standardizedFileURL.path == path.standardizedFileURL.path else {
                throw GuguIOSAccountClosure.failure("closure_path_changed")
            }
        }
        // Missing owner directories are success, so repeating a step after
        // deletion but before its protected checkpoint is safe.
        try FileManager.default.removeItem(at: path)
        let fd = open(path.deletingLastPathComponent().path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw GuguIOSAccountClosure.failure("closure_files_unavailable") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw GuguIOSAccountClosure.failure("closure_files_unavailable") }
    }
}
