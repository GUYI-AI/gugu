#if DEBUG && os(iOS) && targetEnvironment(simulator)
import XCTest
import Security
@testable import App

final class IOSAccountClosureTests: XCTestCase {
    func testRealKeychainLocalOwnerCaptureAndABErasure() throws {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "app.gugu.chat")
        let expected = try XCTUnwrap(ProcessInfo.processInfo.environment["GUGU_D_EXPECTED_SIMULATOR_UDID"])
        XCTAssertEqual(ProcessInfo.processInfo.environment["SIMULATOR_UDID"], expected)
        XCTAssertEqual(GuguAccountClosurePlugin.publicCode(GuguPushFailure(code: "closure_not_prepared", message: "synthetic private message")), "closure_not_prepared")
        XCTAssertEqual(GuguAccountClosurePlugin.publicCode(NSError(domain: "synthetic-private-error", code: 1)), "closure_storage_unavailable")
        let configURL = try XCTUnwrap(Bundle.main.url(forResource: "capacitor.config", withExtension: "json"))
        let config = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as? [String: Any])
        XCTAssertEqual(config["loggingBehavior"] as? String, "none")
        let bundle = "app.gugu.closure-fixture." + UUID().uuidString.lowercased()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: root)
            for service in [bundle + ".auth-storage", bundle + ".account-closure"] {
                SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
            }
        }
        func seedMain(_ owner: String) throws {
            let raw = String(decoding: try JSONSerialization.data(withJSONObject: ["user": ["id": owner]]), as: UTF8.self)
            let bytes = try JSONSerialization.data(withJSONObject: ["state": "SESSION", "raw": raw])
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: bundle + ".auth-storage", kSecAttrAccount as String: "sb-main"]
            SecItemDelete(q as CFDictionary)
            XCTAssertEqual(SecItemAdd(q.merging([kSecValueData as String: bytes, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { _, n in n } as CFDictionary, nil), errSecSuccess)
        }
        let a = GuguIOSClosureScope(ownerId: UUID().uuidString.lowercased(), localOperationId: UUID().uuidString.lowercased())
        let b = GuguIOSClosureScope(ownerId: UUID().uuidString.lowercased(), localOperationId: UUID().uuidString.lowercased())
        let slot = GuguIOSClosureAuthSlot(bundleIdentifier: bundle), secrets = GuguIOSClosureKeychain(bundleIdentifier: bundle)
        let files = GuguIOSClosureFiles(root: root), installation = UUID().uuidString.lowercased()
        let lock = NSRecursiveLock()
        func open() -> GuguIOSAccountClosure {
            GuguIOSAccountClosure(secrets: secrets, installation: { installation }, localAuthBarrier: { body in lock.lock(); defer { lock.unlock() }; try body() }, mainOwner: slot.owner,
                steps: [{ scope in try slot.eraseMainIfOwned(by: scope.ownerId); return true }] + GuguIOSClosureFiles.directories.map { dir in { scope in try files.erase(ownerId: scope.ownerId, directory: dir); return true } }, retained: slot.retainedUnattributed)
        }
        try seedMain(a.ownerId)
        try open().put(a, receipt: "synthetic-secret-A")
        try seedMain(b.ownerId)
        try open().put(b, receipt: "synthetic-secret-B")
        for dir in GuguIOSClosureFiles.directories {
            for owner in [a.ownerId, b.ownerId] {
                let path = root.appendingPathComponent(dir).appendingPathComponent(owner)
                try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
                try Data(owner.utf8).write(to: path.appendingPathComponent("fixture"))
            }
        }
        let tempQuery: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: bundle + ".auth-storage", kSecAttrAccount as String: "sb-main-code-verifier"]
        XCTAssertEqual(SecItemAdd(tempQuery.merging([kSecValueData as String: Data("synthetic-unattributed".utf8)]) { _, n in n } as CFDictionary, nil), errSecSuccess)
        let native = open()
        let outcome = try native.eraseLocal(a)
        XCTAssertEqual(outcome.status, "complete")
        XCTAssertEqual(outcome.retainedUnattributed, ["auth-code-verifier"])
        var retainedData: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(tempQuery.merging([kSecReturnData as String: true]) { _, n in n } as CFDictionary, &retainedData), errSecSuccess)
        XCTAssertEqual(retainedData as? Data, Data("synthetic-unattributed".utf8))
        XCTAssertEqual(try slot.owner(), b.ownerId)
        XCTAssertEqual(try native.get(b), "synthetic-secret-B")
        for dir in GuguIOSClosureFiles.directories {
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(dir).appendingPathComponent(a.ownerId).path))
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(dir).appendingPathComponent(b.ownerId).appendingPathComponent("fixture")), Data(b.ownerId.utf8))
        }
        try native.remove(a); try native.remove(a)
        XCTAssertNil(try native.get(a))
        XCTAssertEqual(try open().eraseLocal(a).status, "complete")
        let uncaptured = GuguIOSClosureScope(ownerId: a.ownerId, localOperationId: UUID().uuidString.lowercased())
        XCTAssertThrowsError(try native.get(uncaptured))
        XCTAssertThrowsError(try native.eraseLocal(uncaptured))
    }
}
#endif
