import Foundation
import CryptoKit

func require(_ value: @autoclosure () throws -> Bool, _ message: String) throws { if try !value() { throw NSError(domain: message, code: 1) } }
func rejected(_ action: () throws -> Void) throws { do { try action() } catch { return }; throw NSError(domain: "Expected rejection", code: 1) }
let root = FileManager.default.temporaryDirectory.appendingPathComponent("GuguSaveTests-" + UUID().uuidString)
defer { try? FileManager.default.removeItem(at: root) }
let bytes = Data("verified PDF bytes".utf8)
let sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
let store = try GuguSaveFileStore(root: root)
func staged() throws -> String {
    let id = try store.begin(name: "test.pdf", size: Int64(bytes.count), sha256: sha, mime: "application/pdf")
    try store.append(id: id, data: bytes); try store.commit(id: id); return id
}
try rejected { _ = try store.begin(name: "../escape.pdf", size: 0, sha256: sha, mime: "application/pdf") }
let bad = try store.begin(name: "bad.pdf", size: Int64(bytes.count), sha256: String(repeating: "0", count: 64), mime: "application/pdf")
try store.append(id: bad, data: bytes); try rejected { try store.commit(id: bad) }
try require(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "bad digest cleaned")
let incomplete = try store.begin(name: "short.pdf", size: 20, sha256: sha, mime: "application/pdf")
try rejected { try store.commit(id: incomplete) }
let overflow = try store.begin(name: "overflow.pdf", size: 1, sha256: sha, mime: "application/pdf")
try rejected { try store.append(id: overflow, data: bytes) }; try store.remove(id: overflow)
for saved in [true, false] {
    let entry = try store.take(id: staged())
    let result = try store.finish(entry, saved: saved, error: nil)
    try require(result == saved, "save or cancel result")
    try require(!FileManager.default.fileExists(atPath: entry.url.path), "save and cancel cleanup")
}
let failed = try store.take(id: staged())
try rejected { _ = try store.finish(failed, saved: false, error: GuguSaveFileStore.failure()) }
try require(!FileManager.default.fileExists(atPath: failed.url.path), "failure cleanup")
let tamperedId = try staged()
let folders = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
try Data("tampered".utf8).write(to: folders[0].appendingPathComponent("test.pdf"))
try rejected { _ = try store.take(id: tamperedId) }; try store.remove(id: tamperedId)
_ = try staged(); let reopened = try GuguSaveFileStore(root: root)
try require(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty, "next launch cleanup")
try require(GuguSaveFileStore.kind(mime: "image/png", name: "x.png") == .image, "image route")
try require(GuguSaveFileStore.kind(mime: "video/mp4", name: "x.mp4") == .video, "video route")
try require(GuguSaveFileStore.kind(mime: "application/pdf", name: "x.pdf") == .file, "document route")
try require(GuguSaveFileStore.kind(mime: "application/octet-stream", name: "x.png") == .image, "generic mime extension route")
let svg = GuguSaveFileStore.kind(mime: "image/svg+xml", name: "drawing.svg")
try require(svg == .image, "SVG recognized as image")
try require(GuguSaveFileStore.destination(kind: svg, photosGranted: true) == .photos, "authorized image first offered to Photos")
try require(GuguSaveFileStore.destination(kind: svg, photosGranted: true, photosAccepted: false) == .files, "Photos rejected SVG falls back to Files")
try require(GuguSaveFileStore.destination(kind: .image, photosGranted: false) == .files, "denied Photos permission falls back to Files")
try require(GuguSaveFileStore.destination(kind: .image, photosGranted: true, photosAccepted: true) == .complete, "accepted Photos save completes")
try require(GuguSaveFileStore.destination(kind: .file, photosGranted: true) == .files, "documents always export to Files")
print("File save verification, routing, save/cancel/failure and launch cleanup: PASS")
