import Foundation

let owner = "11111111-1111-4111-8111-111111111111"
let other = "22222222-2222-4222-8222-222222222222"
let installation = "33333333-3333-4333-8333-333333333333"
var clock = Date(timeIntervalSince1970: 1000)
var record: GuguIOSStoredSession? = GuguIOSStoredSession(ownerId: owner, accessToken: "fixture-a", expiresAt: Date(timeIntervalSince1970: 2000))
var verifies: [(Result<String, Error>) -> Void] = []
var stops: [(Result<Void, Error>) -> Void] = []
let session = GuguIOSOwnerSession(readStored: { record }, installationId: { installation }, verifyUser: { _, done in verifies.append(done) }, stopNative: { stops.append($0) }, now: { clock })
var passed = 0
func check(_ ok: @autoclosure () throws -> Bool, _ label: String) {
    do { guard try ok() else { print("FAIL \(label)"); exit(1) }; passed += 1; print("PASS \(label)") }
    catch { print("FAIL \(label): \(error)"); exit(1) }
}
func rejects(_ work: () throws -> Void) -> Bool { do { try work(); return false } catch { return true } }
func succeeds<T>(_ value: Result<T, Error>?) -> Bool { if case .success? = value { return true }; return false }
var result: Result<GuguIOSHostBinding, Error>?
session.publish(ownerId: owner, accessToken: "not-committed") { result = $0 }
check(!succeeds(result) && verifies.isEmpty, "uncommitted token never reaches verifier")
result = nil
session.publish(ownerId: owner, accessToken: "fixture-a") { result = $0 }
check(try session.snapshot(expectedOwnerId: owner) == nil, "pending verification cannot publish identity")
verifies.removeFirst()(.success(owner))
check(succeeds(result), "server identity match publishes committed owner")
let binding = try session.binding(expectedOwnerId: owner)
check(binding.deviceId == "phone-\(installation)-\(owner)", "uses shared phone registration format")
check(try session.credentials(expectedBinding: binding).accessToken == "fixture-a", "current committed token available only natively")
check(rejects { _ = try session.snapshot(expectedOwnerId: other) }, "old page cannot read another current owner")
record = GuguIOSStoredSession(ownerId: owner, accessToken: "fixture-b", expiresAt: Date(timeIntervalSince1970: 2000))
check(rejects { _ = try session.credentials(expectedBinding: binding) }, "token rotation prevents issuing old native access")
var first: Result<GuguIOSHostBinding, Error>?, second: Result<GuguIOSHostBinding, Error>?
session.publish(ownerId: owner, accessToken: "fixture-b") { first = $0 }
record = GuguIOSStoredSession(ownerId: owner, accessToken: "fixture-c", expiresAt: Date(timeIntervalSince1970: 2000))
session.publish(ownerId: owner, accessToken: "fixture-c") { second = $0 }
verifies.removeFirst()(.success(owner)); verifies.removeFirst()(.success(owner))
check(!succeeds(first) && succeeds(second), "late publication cannot replace newer token generation")
check(try session.credentials(expectedBinding: binding).accessToken == "fixture-c", "latest verified token is supplied")
var retirement: Result<Void, Error>?
session.retire(expectedOwnerId: owner) { retirement = $0 }
check(try session.snapshot(expectedOwnerId: owner) == nil, "retirement invalidates identity before asynchronous stop")
result = nil; session.publish(ownerId: owner, accessToken: "fixture-c") { result = $0 }
check(!succeeds(result) && verifies.isEmpty, "cannot publish while retirement is pending")
stops.removeFirst()(.failure(GuguHostFailure(code: "fixture_io", message: "injected")))
check(!succeeds(retirement), "failed native stop rejects retirement")
result = nil; session.publish(ownerId: owner, accessToken: "fixture-c") { result = $0 }
check(!succeeds(result) && verifies.isEmpty, "failed stop stays closed to publication")
session.retire(expectedOwnerId: owner) { retirement = $0 }; stops.removeFirst()(.success(()))
check(succeeds(retirement), "explicit successful retry clears retirement barrier")
result = nil; session.publish(ownerId: owner, accessToken: "fixture-c") { result = $0 }; verifies.removeFirst()(.success(owner))
check(succeeds(result), "same owner may publish after successful stop")
var transition: Result<Void, Error>?
session.prepareMainWrite(nextOwnerId: other) { transition = $0 }
check(transition == nil && rejects { _ = try session.credentials(expectedBinding: binding) }, "owner storage transition stops before allowing write")
stops.removeFirst()(.success(())); check(succeeds(transition), "completed stop permits storage transition")
record = GuguIOSStoredSession(ownerId: other, accessToken: "fixture-other", expiresAt: Date(timeIntervalSince1970: 2000))
result = nil; session.publish(ownerId: other, accessToken: "fixture-other") { result = $0 }
record = nil; verifies.removeFirst()(.success(other))
check(!succeeds(result), "retired Keychain record rejects late successful verification")
record = GuguIOSStoredSession(ownerId: owner, accessToken: "fixture-c", expiresAt: Date(timeIntervalSince1970: 2000))
session.publish(ownerId: owner, accessToken: "fixture-c") { result = $0 }; verifies.removeFirst()(.success(other))
check(!succeeds(result), "server owner mismatch cannot create identity")
session.publish(ownerId: owner, accessToken: "fixture-c") { result = $0 }; verifies.removeFirst()(.success(owner))
clock = Date(timeIntervalSince1970: 2001)
check(try session.snapshot(expectedOwnerId: owner) == nil && rejects { _ = try session.credentials(expectedBinding: binding) }, "expired credentials cannot supply native access")
let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["GUGU_OWNER_TEST_ROOT"]!).appendingPathComponent(UUID().uuidString.lowercased())
let install = GuguIOSInstallation(directory: root)
let id = try install.identifier()
check(try GuguIOSInstallation(directory: root).identifier() == id, "installation persists across native handle recreation")
try Data("invalid".utf8).write(to: root.appendingPathComponent("installation.json"))
check(rejects { _ = try install.identifier() }, "corrupt installation fails instead of creating another identity")
print("SUMMARY \(passed) policy checks; network/Keychain/iOS App/model/EventKit not exercised")
