import Foundation
import Darwin

let owner = "11111111-1111-4111-8111-111111111111"
let other = "22222222-2222-4222-8222-222222222222"
let installation = "33333333-3333-4333-8333-333333333333"
let authSession = "44444444-4444-4444-8444-444444444444"
let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["GUGU_OWNER_TEST_ROOT"]!)
var checks = 0
func check(_ value: @autoclosure () throws -> Bool, _ label: String) {
    do { guard try value() else { print("FAIL \(label)"); exit(1) }; checks += 1; print("PASS \(label)") }
    catch { print("FAIL \(label): \(error)"); exit(1) }
}
func succeeds<T>(_ value: Result<T, Error>?) -> Bool { if case .success? = value { return true }; return false }
func failureCode<T>(_ value: Result<T, Error>?) -> String? {
    if case .failure(let error)? = value { return (error as? GuguHostFailure)?.code }; return nil
}
func rejectsStale(_ body: () throws -> Void) -> Bool {
    do { try body(); return false } catch { return (error as? GuguHostFailure)?.code == "stale_context" }
}
func jwt(ownerId: String = owner, nonce: String = "original") throws -> String {
    let data = try JSONSerialization.data(withJSONObject: ["sub": ownerId, "session_id": authSession, "nonce": nonce], options: .sortedKeys)
    let encoded = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return "fixture." + encoded + ".synthetic"
}

final class FileSecrets: GuguIOSClosureSecrets {
    let directory: URL
    init(directory: URL) { self.directory = directory }
    func read(_ key: String) throws -> Data? {
        let file = directory.appendingPathComponent(key)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try Data(contentsOf: file)
    }
    func write(_ key: String, data: Data) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        try data.write(to: directory.appendingPathComponent(key), options: .atomic)
    }
}

final class Fixture {
    let directory: URL
    let store: GuguIOSOwnerRetirementStore
    var stored: GuguIOSStoredSession?
    var install = installation
    var running = true
    var stops = 0
    var verifies = 0
    var cleanupFails = false
    var beforeRead: (() throws -> Void)?
    var preparation: GuguIOSOwnerRetirementStore.SignOutPreparation?
    lazy var session: GuguIOSOwnerSession = makeSession()
    lazy var secrets = FileSecrets(directory: directory.appendingPathComponent("receipts"))
    lazy var closure: GuguIOSAccountClosure = GuguIOSAccountClosure(secrets: secrets,
        installation: { self.install }, localAuthBarrier: { body in try self.session.withLocalClosureStorage(body) },
        mainOwner: { self.stored?.ownerId },
        capturePreparation: { scope in try self.session.preparedSignOut(expectedOwnerId: scope.ownerId) },
        cancelPreparation: { scope, preparation in try self.session.cancelSignOut(expectedOwnerId: scope.ownerId, preparation: preparation) },
        steps: [], retained: { [] })

    init(_ name: String) throws {
        directory = root.appendingPathComponent(name)
        store = GuguIOSOwnerRetirementStore(directory: directory)
        stored = .init(ownerId: owner, accessToken: try jwt(), expiresAt: Date(timeIntervalSince1970: 3000))
        if let value = try store.snapshot(), let original = value.original {
            preparation = .init(id: value.id, original: original)
        }
    }
    func makeSession() -> GuguIOSOwnerSession {
        GuguIOSOwnerSession(readStored: { try self.beforeRead?(); return self.stored }, installationId: { self.install },
            verifyUser: { _, done in self.verifies += 1; done(.success(owner)) },
            stopNative: { done in self.stops += 1; self.running = false; done(.success(())) },
            retireExternal: { _, done in
                if self.cleanupFails { done(.failure(GuguHostFailure(code: "fixture_cleanup", message: "synthetic"))) }
                else { done(.success(())) }
            }, retirementStore: store, now: { Date(timeIntervalSince1970: 1000) })
    }
    func prepare() throws {
        var result: Result<Void, Error>?
        session.prepareSignOut(expectedOwnerId: owner) { result = $0 }
        try result!.get()
        preparation = try session.preparedSignOut(expectedOwnerId: owner)
    }
    func recordPreparation() throws -> GuguIOSOwnerRetirementStore.SignOutPreparation {
        let record = try store.snapshot()!
        return .init(id: record.id, original: record.original!)
    }
    func publish(_ target: GuguIOSOwnerSession? = nil) -> Result<GuguIOSHostBinding, Error>? {
        var result: Result<GuguIOSHostBinding, Error>?
        (target ?? session).publish(ownerId: owner, accessToken: stored!.accessToken) { result = $0 }
        return result
    }
}

if CommandLine.arguments.contains("--cold-old-scope") {
    let round = try Fixture("receipt-rounds")
    round.running = false
    let expected = CommandLine.arguments.last!
    let old = GuguIOSClosureScope(ownerId: owner, localOperationId: "first-operation")
    check(rejectsStale { try round.closure.cancelSignOut(old) }, "fresh exec rejects an old removed scope against the next preparation")
    check(try round.store.snapshot()?.id == expected, "fresh exec keeps the new round's seal unchanged")
    exit(0)
}

if CommandLine.arguments.contains("--cold-cancel") {
    let cold = try Fixture("fresh-exec")
    cold.running = false
    check(failureCode(cold.publish()) == "host_not_ready", "fresh exec restores the pending preparation seal")
    try cold.session.cancelSignOut(expectedOwnerId: owner, preparation: cold.preparation!)
    try cold.session.cancelSignOut(expectedOwnerId: owner, preparation: cold.preparation!)
    check(try cold.store.snapshot() == nil && cold.session.snapshot(expectedOwnerId: owner) == nil,
          "fresh exec cancellation removes custody without publishing credentials")
    check(cold.verifies == 0 && cold.stops == 0 && !cold.running,
          "fresh exec cancellation neither authenticates nor starts an agent")
    check(succeeds(cold.publish()) && !cold.running, "fresh exec requires explicit verified publication after cancellation")
    exit(0)
}

let blocked = try Fixture("prepare-blocks")
check(succeeds(blocked.publish()), "original owner can publish before preparation")
try blocked.prepare()
check(try blocked.store.snapshot()?.cleanupComplete == true && !blocked.running,
      "preparation completes cleanup and leaves the native agent stopped")
let verifiesBeforeBlockedPublish = blocked.verifies
check(failureCode(blocked.publish()) == "host_not_ready" && blocked.verifies == verifiesBeforeBlockedPublish,
      "prepare leaves a persistent seal that rejects explicit publication")

try blocked.session.cancelSignOut(expectedOwnerId: owner, preparation: blocked.preparation!)
check(try blocked.store.snapshot() == nil && !blocked.running && blocked.verifies == verifiesBeforeBlockedPublish,
      "cancellation releases only the intent without restarting or verifying an agent")
check(try blocked.session.snapshot(expectedOwnerId: owner) == nil,
      "cancellation does not republish native credentials")
try blocked.session.cancelSignOut(expectedOwnerId: owner, preparation: blocked.preparation!)
check(!blocked.running && succeeds(blocked.publish()),
      "repeated cancellation is idempotent and explicit publication can follow while the agent stays stopped")
try blocked.session.cancelSignOut(expectedOwnerId: owner, preparation: blocked.preparation!)
check(try blocked.session.snapshot(expectedOwnerId: owner) != nil,
      "a duplicate cancellation does not retire a later explicit publication")

let staleOwner = try Fixture("stale-owner")
try staleOwner.prepare()
let originalId = try staleOwner.store.snapshot()!.id
staleOwner.stored = .init(ownerId: other, accessToken: try jwt(ownerId: other), expiresAt: Date(timeIntervalSince1970: 3000))
staleOwner.running = true
check(rejectsStale { try staleOwner.session.cancelSignOut(expectedOwnerId: owner, preparation: staleOwner.preparation!) },
      "another saved owner rejects cancellation of the original preparation")
check(rejectsStale { try staleOwner.session.cancelSignOut(expectedOwnerId: other, preparation: staleOwner.preparation!) },
      "the replacement owner cannot cancel the old owner's preparation")
check(try staleOwner.store.snapshot()?.id == originalId && staleOwner.running && staleOwner.stops == 1,
      "stale cancellation retains original custody and does not affect the other owner")

let changedToken = try Fixture("changed-token")
try changedToken.prepare()
changedToken.stored = .init(ownerId: owner, accessToken: try jwt(nonce: "replaced"), expiresAt: Date(timeIntervalSince1970: 3000))
check(rejectsStale { try changedToken.session.cancelSignOut(expectedOwnerId: owner, preparation: changedToken.preparation!) },
      "same-owner access-token replacement cannot release a prepared intent")
check(try changedToken.store.snapshot() != nil, "changed main credentials remain sealed")

let concurrentWrite = try Fixture("changed-during-cancel")
try concurrentWrite.prepare()
var reads = 0
concurrentWrite.beforeRead = {
    reads += 1
    if reads == 2 { concurrentWrite.stored = .init(ownerId: owner, accessToken: try jwt(nonce: "interleaved"), expiresAt: Date(timeIntervalSince1970: 3000)) }
}
check(rejectsStale { try concurrentWrite.session.cancelSignOut(expectedOwnerId: owner, preparation: concurrentWrite.preparation!) },
      "main credentials are checked again inside the custody transaction")
check(try concurrentWrite.store.snapshot() != nil, "interleaved main replacement cannot remove the original seal")

let changedInstall = try Fixture("changed-installation")
try changedInstall.prepare()
changedInstall.install = "55555555-5555-4555-8555-555555555555"
check(rejectsStale { try changedInstall.session.cancelSignOut(expectedOwnerId: owner, preparation: changedInstall.preparation!) },
      "another installation cannot cancel captured preparation")

let retargeted = try Fixture("retargeted-write")
try retargeted.prepare()
_ = try retargeted.store.begin(target: .init(ownerId: other, accessToken: try jwt(ownerId: other)))
check(rejectsStale { try retargeted.session.cancelSignOut(expectedOwnerId: owner, preparation: retargeted.preparation!) },
      "cancellation cannot discard a retargeted credential write")

let pending = try Fixture("cleanup-pending")
pending.cleanupFails = true
var pendingResult: Result<Void, Error>?
pending.session.prepareSignOut(expectedOwnerId: owner) { pendingResult = $0 }
check(!succeeds(pendingResult), "fixture leaves incomplete cleanup sealed")
check(rejectsStale { try pending.session.cancelSignOut(expectedOwnerId: owner, preparation: try pending.recordPreparation()) },
      "incomplete cleanup is not mistaken for completed sign-out preparation")

let permitFixture = try Fixture("stale-write-permit")
var permit: Result<GuguIOSMainWritePermit, Error>?
permitFixture.session.prepareMainWrite(nextOwnerId: nil, expectedOriginalOwnerId: owner) { permit = $0 }
let oldPermit = try permit!.get()
try permitFixture.session.cancelSignOut(expectedOwnerId: owner, preparation: try permitFixture.recordPreparation())
var committed = false
check(rejectsStale { try permitFixture.session.commitMainWrite(oldPermit) { committed = true } } && !committed,
      "cancellation invalidates an already-issued write permit before persistence")

let cold = try Fixture("cold-cancel")
try cold.prepare()
let restarted = cold.makeSession()
check(failureCode(cold.publish(restarted)) == "host_not_ready", "new native handle restores the durable preparation barrier")
try restarted.cancelSignOut(expectedOwnerId: owner, preparation: cold.preparation!)
check(try cold.store.snapshot() == nil && restarted.snapshot(expectedOwnerId: owner) == nil && !cold.running,
      "a cold handle can cancel durable preparation without publishing or restarting")
check(succeeds(cold.publish(restarted)) && !cold.running, "explicit publication works after cold cancellation without restarting the agent")

let fresh = try Fixture("fresh-exec")
try fresh.prepare()
let child = Process()
child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); child.arguments = ["--cold-cancel"]
child.environment = ProcessInfo.processInfo.environment
try child.run(); child.waitUntilExit()
check(try child.terminationStatus == 0 && fresh.store.snapshot() == nil,
      "a real process restart can cancel the durable sign-out preparation")
try fresh.session.cancelSignOut(expectedOwnerId: owner, preparation: fresh.preparation!)
check(succeeds(fresh.publish()) && !fresh.running,
      "the original handle can reconcile an idempotent cancellation completed by another process")

let round = try Fixture("round-replay")
try round.prepare()
let firstPreparation = try round.recordPreparation()
let firstRound = firstPreparation.id
try round.session.cancelSignOut(expectedOwnerId: owner, preparation: firstPreparation)
try round.prepare()
let nextRound = try round.store.snapshot()!.id
check(firstRound != nextRound, "new preparation receives a different persistent round")
check(rejectsStale { try round.session.cancelSignOut(expectedOwnerId: owner, preparation: firstPreparation) },
      "a captured first-round identifier cannot cancel a later round")
check(try round.store.snapshot()?.id == nextRound, "an old scope cannot cancel the next preparation round")

let receiptRounds = try Fixture("receipt-rounds")
let oldScope = GuguIOSClosureScope(ownerId: owner, localOperationId: "first-operation")
let newScope = GuguIOSClosureScope(ownerId: owner, localOperationId: "second-operation")
try receiptRounds.prepare()
try receiptRounds.closure.put(oldScope, receipt: "synthetic-first-receipt")
check(rejectsStale { try receiptRounds.closure.cancelSignOut(oldScope) },
      "cancellation cannot precede receipt removal")
try receiptRounds.closure.remove(oldScope)
try receiptRounds.closure.cancelSignOut(oldScope)
try receiptRounds.closure.cancelSignOut(oldScope)
check(try receiptRounds.store.snapshot() == nil && !receiptRounds.running,
      "a removed captured scope cancels its round idempotently without restarting")
try receiptRounds.prepare()
let newRoundId = try receiptRounds.store.snapshot()!.id
try receiptRounds.closure.remove(oldScope)
check(rejectsStale { try receiptRounds.closure.cancelSignOut(oldScope) },
      "an old tombstone cannot release a new same-owner preparation")
check(try receiptRounds.store.snapshot()?.id == newRoundId,
      "replaying the first removed scope preserves the second round exactly")
let replay = Process(); replay.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
replay.arguments = ["--cold-old-scope", newRoundId]; replay.environment = ProcessInfo.processInfo.environment
try replay.run(); replay.waitUntilExit()
check(replay.terminationStatus == 0, "old-scope rejection also survives a real process restart")
try receiptRounds.closure.put(newScope, receipt: "synthetic-second-receipt")
try receiptRounds.closure.remove(newScope)
try receiptRounds.closure.cancelSignOut(newScope)
check(try receiptRounds.store.snapshot() == nil && !receiptRounds.running,
      "the second scope can cancel only its own captured preparation")
receiptRounds.stored = .init(ownerId: owner, accessToken: try jwt(nonce: "after-cancellation"), expiresAt: Date(timeIntervalSince1970: 3000))
check(rejectsStale { try receiptRounds.closure.cancelSignOut(newScope) },
      "a cancelled tombstone cannot acknowledge a changed same-owner login")

let deleted = try Fixture("deleted-scope")
let deletedScope = GuguIOSClosureScope(ownerId: owner, localOperationId: "deleted-operation")
try deleted.prepare(); try deleted.closure.put(deletedScope, receipt: "synthetic-deleted-receipt")
_ = try deleted.closure.eraseLocal(deletedScope)
try deleted.closure.remove(deletedScope)
check(rejectsStale { try deleted.closure.cancelSignOut(deletedScope) },
      "a completed deleted scope cannot cancel sign-out preparation")

let legacy = try Fixture("legacy-scope")
let legacyScope = GuguIOSClosureScope(ownerId: owner, localOperationId: "legacy-operation")
try legacy.prepare()
let oldClosure = GuguIOSAccountClosure(secrets: legacy.secrets, installation: { legacy.install },
    localAuthBarrier: { body in try legacy.session.withLocalClosureStorage(body) }, mainOwner: { legacy.stored?.ownerId },
    steps: [], retained: { [] })
try oldClosure.put(legacyScope, receipt: "synthetic-legacy-receipt"); try oldClosure.remove(legacyScope)
check(rejectsStale { try legacy.closure.cancelSignOut(legacyScope) },
      "legacy scope without a captured preparation round is never guessed into authority")

let early = try Fixture("unprepared-capture")
let earlyScope = GuguIOSClosureScope(ownerId: owner, localOperationId: "before-preparation")
var storedBeforePreparation = false
do { try early.closure.put(earlyScope, receipt: "synthetic-early-receipt"); storedBeforePreparation = true }
catch { }
check(storedBeforePreparation, "receipt capture still requires only the current local owner")
try early.prepare()
let laterId = try early.store.snapshot()!.id
try early.closure.put(earlyScope, receipt: "synthetic-early-receipt")
try early.closure.remove(earlyScope)
check(rejectsStale { try early.closure.cancelSignOut(earlyScope) },
      "a receipt captured before preparation cannot acquire a later round through duplicate put")
check(try early.store.snapshot()?.id == laterId, "unbound captured scope leaves the later preparation sealed")

print("SUMMARY \(checks) sign-out preparation checks; injected identity and private files only")
