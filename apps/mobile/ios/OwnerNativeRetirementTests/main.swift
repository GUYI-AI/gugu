import Foundation

@main enum OwnerNativeRetirementChecks {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let ownerId = "11111111-1111-4111-8111-111111111111", install = "22222222-2222-4222-8222-222222222222"
        let originalSession = "33333333-3333-4333-8333-333333333333"
        let binding = GuguIOSHostBinding(ownerId: ownerId, deviceId: "phone-\(install)-\(ownerId)", installationId: install)
        let data = try JSONSerialization.data(withJSONObject: ["sub": ownerId, "session_id": originalSession])
        let token = "fixture." + data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") + ".synthetic"
        var now = Date()
        var stored: GuguIOSStoredSession? = .init(ownerId: ownerId, accessToken: token, expiresAt: now.addingTimeInterval(3600))
        let store = GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("owner"))
        var local: [(Result<Void, Error>) -> Void] = [], verify: [(Result<String, Error>) -> Void] = []
        var nativeCalls = 0, requests = 0, externalCalls = 0, passed = 0
        var cap: GuguIOSRetirementAccess?
        var session: GuguIOSOwnerSession!
        func check(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
            guard try value() else { throw GuguHostFailure(code: "native_retirement_test_failed", message: text) }
            passed += 1; print("PASS \(text)")
        }
        func rejects(_ work: () throws -> Void) -> Bool { do { try work(); return false } catch { return true } }
        let cleanup = try GuguIOSRetirementCleanup(root: root.appendingPathComponent("service"),
            configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "synthetic-public"),
            authorize: { binding, id, operation in
                try session.retirementAuthorization(expectedBinding: binding, retirementId: id, operation: operation)
            }, send: { request, done in
                requests += 1
                guard request.httpMethod == "GET", request.url?.path == "/rest/v1/gugu_devices",
                      request.url?.query?.contains("device_id=eq.") == true,
                      request.url?.query?.contains("user_id=eq.") == true else {
                    done(nil, nil, GuguHostFailure(code: "unexpected_http", message: "Cleanup escaped its device scope")); return
                }
                done(Data("[]".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
            })
        session = GuguIOSOwnerSession(readStored: { stored }, installationId: { install },
            verifyUser: { _, done in verify.append(done) }, stopNative: { local.append($0) },
            retireExternal: { original, done in cap = original; externalCalls += 1; done(.success(())) },
            retireNative: { original, done in
                nativeCalls += 1
                guard let original else { done(.failure(GuguHostFailure(code: "missing_scope", message: "Expected original scope"))); return }
                cleanup.retire(expectedBinding: original.binding, retirementId: original.retirementId, completion: done)
            }, retirementStore: store, now: { now })
        try check(rejects { _ = try session.retirementAuthorization(expectedBinding: binding,
            retirementId: UUID().uuidString.lowercased(), operation: .readOwnedDevice) }, "no cleanup ticket before persistent verified retirement")
        var result: Result<GuguIOSMainWritePermit, Error>?
        let finished = DispatchSemaphore(value: 0)
        session.prepareMainWrite(nextOwnerId: nil) { result = $0; finished.signal() }
        try check(verify.count == 1 && local.count == 1 && nativeCalls == 0 && requests == 0,
                  "cold retirement starts local stop and verification without ordinary publication")
        verify.removeFirst()(.success(ownerId))
        let original = cap!
        let first = try session.retirementAuthorization(expectedBinding: binding, retirementId: original.retirementId, operation: .readOwnedDevice)
        try check(first.binding == binding && first.retirementId == original.retirementId && first.expiresAt <= now.addingTimeInterval(300),
                  "fixed-operation ticket retains old binding and bounded deadline")
        let again = try session.retirementAuthorization(expectedBinding: binding, retirementId: original.retirementId, operation: .readOwnedDevice)
        try check(again.expiresAt == first.expiresAt, "repeated authorization does not roll its five minute deadline")
        try check(externalCalls == 1 && nativeCalls == 0 && result == nil,
                  "native runner waits for local stop even after push fixture completes")
        try check(rejects { _ = try session.credentials(expectedBinding: binding) }, "cleanup ticket never reopens ordinary credentials")
        try check(rejects { _ = try session.retirementAuthorization(expectedBinding: binding,
            retirementId: UUID().uuidString.lowercased(), operation: .readOwnedDevice) }, "wrong transaction cannot obtain cleanup ticket")
        let other = GuguIOSHostBinding(ownerId: "44444444-4444-4444-8444-444444444444",
            deviceId: "phone-\(install)-44444444-4444-4444-8444-444444444444", installationId: install)
        try check(rejects { _ = try session.retirementAuthorization(expectedBinding: other,
            retirementId: original.retirementId, operation: .withdrawOwnedDevice) }, "another owner cannot borrow old cleanup authority")
        let oldNow = now; now = now.addingTimeInterval(301)
        try check(rejects { _ = try session.retirementAuthorization(expectedBinding: binding,
            retirementId: original.retirementId, operation: .readOwnedDevice) }, "expired local cleanup deadline issues no new request")
        now = oldNow
        local.removeFirst()(.success(()))
        try check(finished.wait(timeout: .now() + 5) == .success, "separate native cleanup settles the write barrier")
        let permit = try result!.get()
        try check(nativeCalls == 1 && requests == 1 && store.snapshot()?.cleanupComplete == true,
                  "actual cleanup runner confirms absent original device through injected HTTP")
        try check(rejects { _ = try session.retirementAuthorization(expectedBinding: binding,
            retirementId: original.retirementId, operation: .readOwnedDevice) }, "successful cleanup invalidates its in-memory ticket")
        try session.commitMainWrite(permit) { stored = nil }
        try check(try store.snapshot() == nil, "confirmed native cleanup and exact commit clear original custody")
        passed += try publicationChecks(root: root.appendingPathComponent("publication"))
        print("SUMMARY \(passed) native composition checks; injected HTTP/identity/storage; real network/model/App 0")
    }

    private static func publicationChecks(root: URL) throws -> Int {
        let owner = "55555555-5555-4555-8555-555555555555", install = "66666666-6666-4666-8666-666666666666"
        let authSession = "77777777-7777-4777-8777-777777777777"
        func jwt(_ sessionId: String, _ nonce: String) throws -> String {
            let bytes = try JSONSerialization.data(withJSONObject: ["sub": owner, "session_id": sessionId, "nonce": nonce])
            return "fixture." + bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") + ".synthetic"
        }
        let token = try jwt(authSession, "first"), refresh = try jwt(authSession, "refresh")
        var stored: GuguIOSStoredSession? = .init(ownerId: owner, accessToken: token, expiresAt: Date().addingTimeInterval(3600))
        let store = GuguIOSOwnerRetirementStore(directory: root.appendingPathComponent("owner"))
        var local: [(Result<Void, Error>) -> Void] = [], verify: [(Result<String, Error>) -> Void] = []
        var externalCalls = 0, nativeCalls = 0, requests = 0, passed = 0, failHTTP = false
        var session: GuguIOSOwnerSession!
        func check(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
            guard try value() else { throw GuguHostFailure(code: "publication_cleanup_test_failed", message: text) }
            passed += 1; print("PASS \(text)")
        }
        func rejects(_ work: () throws -> Void) -> Bool { do { try work(); return false } catch { return true } }
        let cleanup = try GuguIOSRetirementCleanup(root: root.appendingPathComponent("service"),
            configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "synthetic-public"),
            authorize: { binding, id, operation in
                try session.retirementAuthorization(expectedBinding: binding, retirementId: id, operation: operation)
            }, send: { request, done in
                requests += 1
                if failHTTP { done(nil, nil, GuguHostFailure(code: "fixture_offline", message: "Synthetic cleanup failure")); return }
                done(Data("[]".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
            })
        func newSession() -> GuguIOSOwnerSession {
            GuguIOSOwnerSession(readStored: { stored }, installationId: { install },
                verifyUser: { _, done in verify.append(done) }, stopNative: { local.append($0) },
                retireExternal: { _, done in externalCalls += 1; done(.success(())) },
                retireNative: { original, done in
                    nativeCalls += 1
                    guard let original else { done(.failure(GuguHostFailure(code: "missing_scope", message: "Expected original scope"))); return }
                    cleanup.retire(expectedBinding: original.binding, retirementId: original.retirementId, completion: done)
                }, retirementStore: store)
        }
        session = newSession()
        var publication: Result<GuguIOSHostBinding, Error>?
        session.publish(ownerId: owner, accessToken: token) { publication = $0 }
        verify.removeFirst()(.success(owner))
        let binding = try publication!.get()
        var stopped: Result<Void, Error>?
        let stopDone = DispatchSemaphore(value: 0)
        session.retire(expectedOwnerId: owner) { stopped = $0; stopDone.signal() }
        try check(try store.snapshot()?.isPublicationOnly == true && stopped == nil && externalCalls == 0,
                  "ordinary stop persists separate cleanup custody without permanently closing push")
        try check(rejects { _ = try session.credentials(expectedBinding: binding) }, "ordinary stop seals native credentials before cleanup")
        verify.removeFirst()(.success(owner))
        try check(nativeCalls == 0 && requests == 0, "ordinary cleanup also waits for the local stop barrier")
        local.removeFirst()(.success(()))
        try check(stopDone.wait(timeout: .now() + 5) == .success, "ordinary stop waits for actual cleanup runner completion")
        try stopped!.get()
        try check(try nativeCalls == 1 && requests == 1 && externalCalls == 0 && store.snapshot() == nil,
                  "confirmed ordinary cleanup releases only its publication custody")
        session.publish(ownerId: owner, accessToken: token) { publication = $0 }
        verify.removeFirst()(.success(owner))
        try check(try publication!.get() == binding && stored?.accessToken == token,
                  "same saved Auth session can be verified again after ordinary cleanup")

        failHTTP = true; stopped = nil
        session.retire(expectedOwnerId: owner) { stopped = $0; stopDone.signal() }
        verify.removeFirst()(.success(owner)); local.removeFirst()(.success(()))
        try check(stopDone.wait(timeout: .now() + 5) == .success, "failed native cleanup returns a concrete result")
        try check(try rejects { try stopped!.get() } && store.snapshot()?.isPublicationOnly == true && externalCalls == 0,
                  "unknown ordinary cleanup remains durable and does not close push")
        let oldID = try store.snapshot()!.id
        session = newSession(); failHTTP = false
        try check(rejects { _ = try session.credentials(expectedBinding: binding) }, "cold ordinary cleanup cannot borrow regular credentials")
        var write: Result<GuguIOSMainWritePermit, Error>?
        let writeDone = DispatchSemaphore(value: 0)
        session.prepareMainWrite(nextOwnerId: owner, nextAccessToken: refresh) { write = $0; writeDone.signal() }
        try check(try write == nil && store.snapshot()?.id == oldID && externalCalls == 0,
                  "refresh first resumes the original publication-only transaction")
        verify.removeFirst()(.success(owner)); local.removeFirst()(.success(()))
        try check(writeDone.wait(timeout: .now() + 5) == .success, "cold native cleanup completes before a same-session refresh permit")
        try session.commitMainWrite(write!.get()) { stored = .init(ownerId: owner, accessToken: refresh, expiresAt: Date().addingTimeInterval(3600)) }
        try check(try store.snapshot() == nil && externalCalls == 0 && stored?.accessToken == refresh,
                  "same-session refresh preserves push after settling interrupted ordinary cleanup")

        let replacement = try jwt("88888888-8888-4888-8888-888888888888", "replacement")
        write = nil
        session.prepareMainWrite(nextOwnerId: owner, nextAccessToken: replacement) { write = $0; writeDone.signal() }
        verify.removeFirst()(.success(owner)); local.removeFirst()(.success(()))
        try check(writeDone.wait(timeout: .now() + 5) == .success, "new Auth session still awaits native cleanup")
        try check(try externalCalls == 1 && store.snapshot()?.isPublicationOnly == false,
                  "new Auth session retains the permanent push close barrier")
        try session.commitMainWrite(write!.get()) { stored = .init(ownerId: owner, accessToken: replacement, expiresAt: Date().addingTimeInterval(3600)) }
        try check(try store.snapshot() == nil, "exact replacement commit clears credential-write custody")
        return passed
    }
}
