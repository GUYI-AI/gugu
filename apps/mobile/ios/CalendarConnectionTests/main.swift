import Foundation

final class Fixture {
    let root: URL
    var binding: GuguIOSHostBinding
    var active = true
    var fullAccess = false
    var revocations = 0
    var requests: [(Result<Void, Error>) -> Void] = []
    lazy var ownerAccess = GuguIOSOwnerAccess(root: root,
        verifiedIdentity: { self.binding },
        requireOwnerUI: { if !self.active { throw GuguHostFailure(code: "not_granted", message: "Fixture UI inactive") } },
        calendarHasFullAccess: { self.fullAccess }, revokeCalendarAccess: { self.revocations += 1 })
    lazy var connection = GuguCalendarConnection(ownerAccess: ownerAccess, hasFullAccess: { self.fullAccess },
        requestAccess: { check, done in
            do { try check(); self.requests.append(done) } catch { done(.failure(error)) }
        })
    init() throws {
        root = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(UUID().uuidString, isDirectory: true)
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
    }
    func snapshot() throws -> GuguIOSOwnerSnapshot { try connection.snapshot(ownerId: binding.ownerId) }
    func cleanup() throws { if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) } }
}

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try condition() == false { throw GuguHostFailure(code: "assertion_failed", message: message) }
}
func rejects<T>(_ code: String, _ body: () throws -> T) throws {
    do { _ = try body(); throw GuguHostFailure(code: "missing_rejection", message: code) }
    catch let failure as GuguHostFailure { try expect(failure.code == code, "Unexpected rejection \(failure.code); expected \(code)") }
}
var results: [[String: Any]] = []
func run(_ name: String, _ body: (Fixture) throws -> Void) throws {
    let fixture = try Fixture()
    defer { try? fixture.cleanup() }
    try body(fixture)
    results.append(["name": name, "passed": true])
}
try run("initial state disconnected") { f in
    try expect(try f.snapshot().calendarConnected == false, "Initial native choice")
    try expect(f.revocations == 0 && f.requests.isEmpty, "Read must not prompt")
}
try run("stale page cannot connect another owner") { f in
    let stale = GuguIOSHostBinding(ownerId: UUID().uuidString, deviceId: f.binding.deviceId, installationId: f.binding.installationId)
    var result: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: stale) { result = $0 }
    try rejects("stale_context") { try result!.get() }
    try expect(f.requests.isEmpty && f.revocations == 0, "Stale page reached OS")
}
try run("background UI cannot request") { f in
    f.active = false
    var result: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: f.binding) { result = $0 }
    try rejects("not_granted") { try result!.get() }
    try expect(f.requests.isEmpty, "Background requested OS access")
}
try run("OS denial leaves disconnected after invalidating old context") { f in
    var result: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: f.binding) { result = $0 }
    try expect(f.revocations == 1 && f.requests.count == 1, "Invalidate before prompt")
    f.requests[0](.success(()))
    try rejects("os_permission") { try result!.get() }
    try expect(try f.snapshot().calendarConnected == false, "Denied permission connected")
}
try run("real full-access result connects current attempt") { f in
    var result: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: f.binding) { result = $0 }
    f.fullAccess = true; f.requests[0](.success(()))
    let snapshot = try result!.get()
    try expect(snapshot.binding == f.binding && snapshot.calendarConnected && snapshot.calendarRevision != nil, "Native snapshot missing")
}
try run("account change discards delayed permission result") { f in
    let original = f.binding
    var result: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: original) { result = $0 }
    let nextOwner = UUID().uuidString.lowercased()
    f.binding = GuguIOSHostBinding(ownerId: nextOwner, deviceId: "phone-\(original.installationId)-\(nextOwner)", installationId: original.installationId)
    f.fullAccess = true; f.requests[0](.success(()))
    try rejects("stale_context") { try result!.get() }
    f.binding = original
    try expect(try f.snapshot().calendarConnected == false, "Old attempt connected after account switch")
}
try run("new attempt supersedes old OS callback") { f in
    var first: Result<GuguIOSOwnerSnapshot, Error>?, second: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: f.binding) { first = $0 }
    f.connection.connect(expectedBinding: f.binding) { second = $0 }
    f.fullAccess = true; f.requests[0](.success(())); f.requests[1](.success(()))
    try rejects("stale_context") { try first!.get() }
    try expect(try second!.get().calendarConnected, "Latest attempt not connected")
}
try run("disconnect prevents pending callback from reconnecting") { f in
    var result: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: f.binding) { result = $0 }
    _ = try f.connection.disconnect(expectedBinding: f.binding)
    f.fullAccess = true; f.requests[0](.success(()))
    try rejects("stale_context") { try result!.get() }
    try expect(try f.snapshot().calendarConnected == false, "Disconnected attempt revived")
}
try run("observed OS revocation retires selected connection") { f in
    var result: Result<GuguIOSOwnerSnapshot, Error>?
    f.connection.connect(expectedBinding: f.binding) { result = $0 }
    f.fullAccess = true; f.requests[0](.success(())); _ = try result!.get()
    f.fullAccess = false
    try expect(try f.snapshot().calendarConnected == false, "OS revocation left connected")
    try expect(f.revocations == 2, "Revocation did not retire context")
}
print(String(decoding: try JSONSerialization.data(withJSONObject: ["checks": results, "count": results.count,
    "realModelCalls": 0, "realEventKitCalls": 0, "iOSAppVerified": false], options: [.sortedKeys]), as: UTF8.self))
