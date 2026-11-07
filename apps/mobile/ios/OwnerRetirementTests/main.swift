import Foundation

let owner = "11111111-1111-4111-8111-111111111111"
let other = "22222222-2222-4222-8222-222222222222"
let installation = "33333333-3333-4333-8333-333333333333"
var install = installation
var now = Date(timeIntervalSince1970: 1000)
var stored: GuguIOSStoredSession? = .init(ownerId: owner, accessToken: "synthetic-a", expiresAt: Date(timeIntervalSince1970: 2000))
var external: [(GuguIOSRetirementAccess?, (Result<Void, Error>) -> Void)] = []
var local: [(Result<Void, Error>) -> Void] = []
let session = GuguIOSOwnerSession(readStored: { stored }, installationId: { install },
    verifyUser: { _, done in done(.success(owner)) }, stopNative: { local.append($0) },
    retireExternal: { access, done in external.append((access, done)) }, now: { now })
var count = 0
func check(_ value: @autoclosure () throws -> Bool, _ label: String) {
    do { if try !value() { print("FAIL \(label)"); exit(1) }; count += 1; print("PASS \(label)") }
    catch { print("FAIL \(label): \(error)"); exit(1) }
}
func rejects(_ block: () throws -> Void) -> Bool { do { try block(); return false } catch { return true } }
func success<T>(_ result: Result<T, Error>?) -> Bool { if case .success? = result { return true }; return false }
var published: Result<GuguIOSHostBinding, Error>?
session.publish(ownerId: owner, accessToken: "synthetic-a") { published = $0 }
let binding = try published!.get()
var write: Result<GuguIOSMainWritePermit, Error>?
session.prepareMainWrite(nextOwnerId: other) { write = $0 }
let first = external[0].0!
check(write == nil && external.count == 1 && local.count == 1, "external retirement and local stop both start before storage admission")
check(rejects { _ = try session.credentials(expectedBinding: binding) }, "general credentials close before external callback")
check(try session.retirementCredentials(first, expectedBinding: binding).accessToken == "synthetic-a", "exact native retirement capability retains original committed access")
let wrong = GuguIOSHostBinding(ownerId: other, deviceId: "phone-\(installation)-\(other)", installationId: installation)
check(rejects { _ = try session.retirementCredentials(first, expectedBinding: wrong) }, "retirement capability cannot target another owner")
external[0].1(.failure(GuguHostFailure(code: "push_unknown", message: "injected")))
check(write == nil, "external failure still waits for local transport stop")
external[0].1(.success(()))
local[0](.success(()))
check(!success(write), "duplicate external completion cannot erase the original failure")
check(rejects { _ = try session.credentials(expectedBinding: binding) }, "failed retirement keeps ordinary access sealed")
write = nil
session.prepareMainWrite(nextOwnerId: other) { write = $0 }
let second = external[1].0!
check(rejects { _ = try session.retirementCredentials(first, expectedBinding: binding) }, "explicit retry invalidates the previous retirement capability")
stored = .init(ownerId: owner, accessToken: "unpublished-token", expiresAt: Date(timeIntervalSince1970: 2000))
check(rejects { _ = try session.retirementCredentials(second, expectedBinding: binding) }, "unpublished replacement token rejects old retirement access")
stored = .init(ownerId: owner, accessToken: "synthetic-a", expiresAt: Date(timeIntervalSince1970: 2000))
install = "44444444-4444-4444-8444-444444444444"
check(rejects { _ = try session.retirementCredentials(second, expectedBinding: binding) }, "native install changes reject retirement access")
install = installation; now = Date(timeIntervalSince1970: 2001)
check(rejects { _ = try session.retirementCredentials(second, expectedBinding: binding) }, "expired retirement access cannot issue requests")
now = Date(timeIntervalSince1970: 1000)
local[1](.success(())); check(write == nil, "local stop alone cannot admit the new Keychain owner")
external[1].1(.success(())); check(success(write), "both successful retirements admit one storage write")
check(rejects { _ = try session.retirementCredentials(second, expectedBinding: binding) }, "successful stop invalidates retirement access before storage commit")
try session.commitMainWrite(write!.get()) {
    stored = .init(ownerId: other, accessToken: "synthetic-b", expiresAt: Date(timeIntervalSince1970: 2000))
}
check(rejects { _ = try session.retirementCredentials(second, expectedBinding: binding) }, "new stored owner cannot revive previous retirement access")
print("SUMMARY \(count) retirement policy checks; synthetic credentials only; no Keychain/HTTP/APNs/App")
