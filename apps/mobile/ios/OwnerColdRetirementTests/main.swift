import Foundation

let owner = "11111111-1111-4111-8111-111111111111"
let other = "22222222-2222-4222-8222-222222222222"
let installation = "33333333-3333-4333-8333-333333333333"
let authSession = "44444444-4444-4444-8444-444444444444"
func jwt(_ nonce: String) throws -> String {
    let bytes = try JSONSerialization.data(withJSONObject: ["sub": owner, "session_id": authSession, "nonce": nonce], options: .sortedKeys)
    return "fixture." + bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") + ".synthetic"
}
let token = try jwt("original")
let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["GUGU_OWNER_TEST_ROOT"]!)
let store = GuguIOSOwnerRetirementStore(directory: root)
var stored: GuguIOSStoredSession? = .init(ownerId: owner, accessToken: token, expiresAt: Date(timeIntervalSince1970: 3000))
var now = Date(timeIntervalSince1970: 1000)
var install = installation
var verifies: [(Result<String, Error>) -> Void] = []
var stops = 0
var callbacks: [(GuguIOSRetirementAccess?, (Result<Void, Error>) -> Void)] = []
let session = GuguIOSOwnerSession(readStored: { stored }, installationId: { install },
    verifyUser: { _, done in verifies.append(done) }, stopNative: { stops += 1; $0(.success(())) },
    retireExternal: { callbacks.append(($0, $1)) }, retirementStore: store, now: { now })
var count = 0
func check(_ value: @autoclosure () throws -> Bool, _ label: String) {
    do { guard try value() else { print("FAIL \(label)"); exit(1) }; count += 1; print("PASS \(label)") }
    catch { print("FAIL \(label): \(error)"); exit(1) }
}
func rejects(_ body: () throws -> Void) -> Bool { do { try body(); return false } catch { return true } }
func succeeded<T>(_ result: Result<T, Error>?) -> Bool { if case .success? = result { return true }; return false }

if CommandLine.arguments.contains("--cold-child") {
    let expected = CommandLine.arguments.last!
    var published: Result<GuguIOSHostBinding, Error>?
    session.publish(ownerId: owner, accessToken: token) { published = $0 }
    check(!succeeded(published) && verifies.isEmpty, "fresh exec cannot republish the persisted old login")
    var permit: Result<GuguIOSMainWritePermit, Error>?
    session.prepareMainWrite(nextOwnerId: nil) { permit = $0 }
    check(try store.snapshot()?.id == expected && callbacks.isEmpty && verifies.count == 1 && stops == 1,
          "fresh exec preserves transaction and waits for identity verification")
    verifies.removeFirst()(.success(owner))
    let capability = callbacks[0].0!
    check(try capability.retirementId == expected && session.retirementCredentials(capability, expectedBinding: binding).accessToken == token,
          "cold cleanup gets exact old scope without ordinary publication")
    check(rejects { _ = try session.credentials(expectedBinding: binding) }, "cold cleanup cannot reopen ordinary credentials")
    callbacks[0].1(.failure(GuguHostFailure(code: "fixture_unknown", message: "synthetic")))
    check(!succeeded(permit), "cold unknown cleanup keeps persistent barrier")
    exit(0)
}

var permit: Result<GuguIOSMainWritePermit, Error>?
session.prepareMainWrite(nextOwnerId: nil) { permit = $0 }
let firstRecord = try store.snapshot()!
check(firstRecord.captureComplete && !firstRecord.cleanupComplete && stops == 1 && callbacks.isEmpty,
      "intent and original session persist before external cleanup")
check(permit == nil && verifies.count == 1, "cold original login requires online identity verification")
let raw = try String(contentsOf: root.appendingPathComponent("owner-retirement.json"), encoding: .utf8)
check(!raw.contains(token) && !raw.contains("refreshToken"), "persistent transaction contains no credential bytes")
var published: Result<GuguIOSHostBinding, Error>?
session.publish(ownerId: owner, accessToken: token) { published = $0 }
check(!succeeded(published) && verifies.count == 1, "pending intent blocks publication before verifier")
verifies.removeFirst()(.success(other))
check(!succeeded(permit) && callbacks.isEmpty, "wrong online identity issues no cleanup capability")

let child = Process(); child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
child.arguments = ["--cold-child", firstRecord.id]; child.environment = ProcessInfo.processInfo.environment
try child.run(); child.waitUntilExit()
check(child.terminationStatus == 0, "real exec preserves and enforces pending retirement")

permit = nil
session.prepareMainWrite(nextOwnerId: nil) { permit = $0 }
verifies.removeFirst()(.success(owner))
let capability = callbacks[0].0!
check(capability.retirementId == firstRecord.id, "explicit retry reuses durable retirement ID")
check(try session.retirementCredentials(capability, expectedBinding: binding).originalSessionId() == authSession,
      "verified native capability retains original JWT session")
now = Date(timeIntervalSince1970: 1300)
check(rejects { _ = try session.retirementCredentials(capability, expectedBinding: binding) }, "five minute native capability expires without token refresh")
now = Date(timeIntervalSince1970: 1000)
install = "55555555-5555-4555-8555-555555555555"
check(rejects { _ = try session.retirementCredentials(capability, expectedBinding: binding) }, "installation replacement rejects cleanup authority")
install = installation
stored = .init(ownerId: owner, accessToken: try jwt("unpublished"), expiresAt: Date(timeIntervalSince1970: 3000))
check(rejects { _ = try session.retirementCredentials(capability, expectedBinding: binding) }, "unpublished token replacement rejects cleanup authority")
stored = .init(ownerId: owner, accessToken: token, expiresAt: Date(timeIntervalSince1970: 3000))
callbacks[0].1(.failure(GuguHostFailure(code: "fixture_unknown", message: "synthetic")))
check(try !succeeded(permit) && store.snapshot()?.id == firstRecord.id, "failed cleanup cannot clear or replace durable intent")

permit = nil
session.prepareMainWrite(nextOwnerId: nil) { permit = $0 }; verifies.removeFirst()(.success(owner))
check(rejects { _ = try session.retirementCredentials(capability, expectedBinding: binding) }, "retry invalidates old in-memory capability")
callbacks[1].1(.success(()))
check(try succeeded(permit) && store.snapshot()?.cleanupComplete == true, "all cleanup must complete before write permit")
check(rejects { try session.commitMainWrite(permit!.get()) { throw GuguHostFailure(code: "fixture_keychain", message: "synthetic") } },
      "failed Keychain write propagates after cleanup")
check(try store.snapshot()?.id == firstRecord.id && rejects { _ = try session.credentials(expectedBinding: binding) },
      "write failure leaves durable barrier and general credentials closed")
try session.commitMainWrite(permit!.get()) { stored = nil }
check(try store.snapshot() == nil, "exact successful Keychain commit clears persisted transaction")

let recovery = root.appendingPathComponent("commit-crash")
let recoveryStore = GuguIOSOwnerRetirementStore(directory: recovery)
let expected = try GuguIOSOwnerRetirementStore.Target(ownerId: owner, accessToken: try jwt("next"))
let recoveryRecord = try recoveryStore.begin(target: expected)
_ = try recoveryStore.capture(id: recoveryRecord.id, original: nil)
check(try !recoveryStore.recoverCommittedWrite(stored: stored), "incomplete cleanup cannot recover as committed")
try recoveryStore.markCleanupComplete(id: recoveryRecord.id)
check(try !recoveryStore.recoverCommittedWrite(stored: .init(ownerId: owner, accessToken: token, expiresAt: now)),
      "different same-owner token cannot clear completed-cleanup intent")
check(try GuguIOSOwnerRetirementStore(directory: recovery).recoverCommittedWrite(stored: .init(ownerId: owner, accessToken: jwt("next"), expiresAt: now)),
      "new handle recovers exact commit after crash without remote replay")

try Data("broken".utf8).write(to: root.appendingPathComponent("owner-retirement.json"))
stored = .init(ownerId: owner, accessToken: token, expiresAt: Date(timeIntervalSince1970: 3000))
session.publish(ownerId: owner, accessToken: token) { published = $0 }
check(!succeeded(published), "corrupt pending transaction cannot become empty custody")

let missing = GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("missing-keychain"))
let missingRecord = try missing.begin(target: .init(ownerId: nil, accessToken: nil))
_ = try missing.capture(id: missingRecord.id, original: .init(binding: binding, sessionId: authSession,
    accessSHA256: GuguIOSOwnerRetirementStore.digest(token)))
var missingExternal = 0, missingStops = 0
let missingSession = GuguIOSOwnerSession(readStored: { nil }, installationId: { installation },
    verifyUser: { _, done in done(.success(owner)) }, stopNative: { missingStops += 1; $0(.success(())) },
    retireExternal: { _, done in missingExternal += 1; done(.success(())) }, retirementStore: missing, now: { now })
var missingResult: Result<Void, Error>?
missingSession.retire(expectedOwnerId: owner) { missingResult = $0 }
check(try !succeeded(missingResult) && missingExternal == 0 && missingStops == 1 && missing.snapshot()?.cleanupComplete == false,
      "missing original Keychain cannot convert an empty callback into server cleanup proof")

let unreadable = GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("unreadable-keychain"))
var readFails = true
let unreadableSession = GuguIOSOwnerSession(readStored: {
    if readFails { throw GuguHostFailure(code: "fixture_read", message: "synthetic") }; return stored
}, installationId: { installation }, verifyUser: { _, done in done(.success(owner)) },
    stopNative: { $0(.success(())) }, retireExternal: { _, done in done(.success(())) }, retirementStore: unreadable, now: { now })
unreadableSession.prepareMainWrite(nextOwnerId: nil) { permit = $0 }
check(try !succeeded(permit) && unreadable.snapshot()?.captureComplete == false,
      "failed old Keychain read leaves durable uncaptured intent")
readFails = false
unreadableSession.publish(ownerId: owner, accessToken: token) { published = $0 }
check(!succeeded(published), "restored old Keychain bytes cannot bypass failed read intent")

let firstLogin = GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("first-login"))
var firstStored: GuguIOSStoredSession?
let firstSession = GuguIOSOwnerSession(readStored: { firstStored }, installationId: { installation },
    verifyUser: { _, done in done(.success(owner)) }, stopNative: { $0(.success(())) },
    retireExternal: { cap, done in check(cap == nil, "first login does not invent an old cleanup scope"); done(.success(())) },
    retirementStore: firstLogin, now: { now })
firstSession.prepareMainWrite(nextOwnerId: owner, nextAccessToken: token) { permit = $0 }
check(succeeded(permit), "genuinely absent original login can admit initial storage")
let firstPermit = try permit!.get()
let firstID = try firstLogin.snapshot()!.id
let replacedTarget = try firstLogin.begin(target: .init(ownerId: other, accessToken: "synthetic-other"))
check(replacedTarget.id == firstID, "explicit replacement intent retains original cleanup transaction")
var wroteBeforeTargetCheck = false
check(rejects { try firstSession.commitMainWrite(firstPermit) { wroteBeforeTargetCheck = true } } && !wroteBeforeTargetCheck,
      "retargeted transaction rejects earlier permit before Keychain mutation")
_ = try firstLogin.begin(target: .init(ownerId: owner, accessToken: token))
// Represents another process completing that same prepared commit.
try firstLogin.finishCommit(id: firstID, stored: .init(ownerId: owner, accessToken: token, expiresAt: now))
var wroteAfterOtherCommit = false
check(rejects { try firstSession.commitMainWrite(firstPermit) { wroteAfterOtherCommit = true } } && !wroteAfterOtherCommit,
      "cross-handle completed transaction rejects stale permit before Keychain mutation")
print("SUMMARY \(count) parent checks plus fresh-exec checks; private APFS and injected identity; no Keychain/HTTP/App")
