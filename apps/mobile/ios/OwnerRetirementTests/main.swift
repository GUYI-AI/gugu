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
var scopeStored: GuguIOSStoredSession? = .init(ownerId: owner, accessToken: "synthetic-scope", expiresAt: Date(timeIntervalSince1970: 2000))
var scopeLocal: [(Result<Void, Error>) -> Void] = []
var scopeExternal: [(GuguIOSRetirementAccess?, (Result<Void, Error>) -> Void)] = []
let scoped = GuguIOSOwnerSession(readStored: { scopeStored }, installationId: { installation },
    verifyUser: { _, done in done(.success(owner)) }, stopNative: { scopeLocal.append($0) },
    retireExternal: { access, done in scopeExternal.append((access, done)) }, now: { now })
scoped.publish(ownerId: owner, accessToken: "synthetic-scope") { published = $0 }
var stopped: Result<Void, Error>?
scoped.retire(expectedOwnerId: owner) { stopped = $0 }
check(scopeExternal.isEmpty && scopeLocal.count == 1, "publication stop does not permanently close the still-committed Auth session")
scopeLocal[0](.success(()))
scoped.publish(ownerId: owner, accessToken: "synthetic-scope") { published = $0 }
check(success(stopped) && success(published), "ordinary publication stop supports re-verifying the same saved login")
var pending: Result<GuguIOSMainWritePermit, Error>?
scoped.prepareMainWrite(nextOwnerId: nil) { pending = $0 }
scopeExternal[0].1(.success(())); scopeLocal[1](.success(()))
let pendingPermit = try pending!.get()
check(rejects { try scoped.commitMainWrite(pendingPermit) { throw GuguHostFailure(code: "fixture_io", message: "synthetic") } }, "failed Keychain persistence preserves the original storage intent")
scoped.retire(expectedOwnerId: owner) { stopped = $0 }
check(scopeExternal.count == 2 && scopeExternal[1].0 != nil, "stop retry retains required server cleanup for the pending storage intent")
scopeExternal[1].1(.success(())); scopeLocal[2](.success(()))
scoped.publish(ownerId: owner, accessToken: "synthetic-scope") { published = $0 }
check(success(stopped) && !success(published), "successful stop cannot bypass a failed credential-write retirement latch")
func jwt(_ sessionId: String, _ nonce: String) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: ["sub": owner, "session_id": sessionId, "nonce": nonce])
    return "fixture." + data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") + ".synthetic"
}
let s1 = "55555555-5555-4555-8555-555555555555"
let s2 = "66666666-6666-4666-8666-666666666666"
let t1 = try jwt(s1, "initial"), refreshed = try jwt(s1, "refresh"), t2 = try jwt(s2, "replacement")
var authStored: GuguIOSStoredSession? = .init(ownerId: owner, accessToken: t1, expiresAt: Date(timeIntervalSince1970: 2000))
var authExternal: [(GuguIOSRetirementAccess?, (Result<Void, Error>) -> Void)] = []
var authLocal: [(Result<Void, Error>) -> Void] = []
let auth = GuguIOSOwnerSession(readStored: { authStored }, installationId: { installation },
    verifyUser: { _, done in done(.success(owner)) }, stopNative: { authLocal.append($0) },
    retireExternal: { cap, done in authExternal.append((cap, done)) }, now: { now })
var authWrite: Result<GuguIOSMainWritePermit, Error>?
auth.prepareMainWrite(nextOwnerId: owner, nextAccessToken: refreshed) { authWrite = $0 }
check(success(authWrite) && authExternal.isEmpty && authLocal.isEmpty, "same-session refresh before publication does not close its Auth session")
try auth.commitMainWrite(authWrite!.get()) { authStored = .init(ownerId: owner, accessToken: refreshed, expiresAt: Date(timeIntervalSince1970: 2000)) }
auth.publish(ownerId: owner, accessToken: refreshed) { published = $0 }
check(success(published), "refreshed access is usable only after fresh server identity verification")
authWrite = nil
auth.prepareMainWrite(nextOwnerId: owner, nextAccessToken: t2) { authWrite = $0 }
check(authWrite == nil && authExternal.count == 1 && authLocal.count == 1, "same owner with a new Auth session starts both retirement barriers")
let authCap = authExternal[0].0!
check(try auth.retirementCredentials(authCap, expectedBinding: binding).originalSessionId() == s1, "session replacement cleanup retains the original JWT session scope")
check(rejects { _ = try auth.credentials(expectedBinding: binding) }, "session replacement seals ordinary credentials before cleanup")
authExternal[0].1(.success(()))
check(authWrite == nil && authStored?.accessToken == refreshed, "server cleanup alone cannot commit replacement credentials")
authLocal[0](.success(()))
try auth.commitMainWrite(authWrite!.get()) { authStored = .init(ownerId: owner, accessToken: t2, expiresAt: Date(timeIntervalSince1970: 2000)) }
auth.publish(ownerId: owner, accessToken: t2) { published = $0 }
check(try success(published) && auth.credentials(expectedBinding: binding).originalSessionId() == s2, "new session publishes after cleanup and committed storage")
let t2refresh = try jwt(s2, "refreshed")
auth.prepareMainWrite(nextOwnerId: owner, nextAccessToken: t2refresh) { authWrite = $0 }
check(authExternal.count == 1 && authLocal.count == 1 && success(authWrite), "published same-session token refresh preserves push registration")
check(rejects { try auth.commitMainWrite(authWrite!.get()) { authStored = .init(ownerId: owner, accessToken: t1, expiresAt: Date(timeIntervalSince1970: 2000)) } }, "storage permit rejects a different same-owner token than the prepared write")
check(rejects { _ = try auth.credentials(expectedBinding: binding) }, "mismatched write readback stays sealed")
print("SUMMARY \(count) retirement policy checks; synthetic credentials only; no Keychain/HTTP/APNs/App")
