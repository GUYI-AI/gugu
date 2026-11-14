import Foundation

@MainActor final class RetirementPlatform: GuguPushPlatform {
    var registrationPending = false
    var unregistered = 0
    var cleared = 0
    func settings() async -> GuguPushSettings {
        .init(authorization: .denied, alert: .disabled, sound: .disabled, badge: .disabled,
              notificationCenter: .disabled, lockScreen: .disabled)
    }
    func requestAuthorization(check: @escaping () throws -> Void) async throws { throw GuguPushFailure.permission }
    func deviceToken(ticket: GuguPushTicket, check: @escaping () throws -> Void) async throws -> Data { throw GuguPushFailure.permission }
    func unregister() { unregistered += 1 }
    func clearDelivered() { cleared += 1 }
}

@main struct PushRetirementChecks {
    @MainActor static func main() async throws {
        let owner = "11111111-1111-4111-8111-111111111111"
        let installation = "33333333-3333-4333-8333-333333333333"
        let originalSession = "44444444-4444-4444-8444-444444444444"
        let fence = "55555555-5555-4555-8555-555555555555"
        let payload = try JSONSerialization.data(withJSONObject: ["sub": owner, "session_id": originalSession])
            .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let token = "fixture." + payload + ".synthetic"
        var stored: GuguIOSStoredSession? = .init(ownerId: owner, accessToken: token, expiresAt: Date().addingTimeInterval(3600))
        var assembly: GuguIOSPushRetirement!
        var localStops = 0, closeCalls = 0, mode = "fenced"
        let session = GuguIOSOwnerSession(readStored: { stored }, installationId: { installation },
            verifyUser: { _, done in done(.success(owner)) }, stopNative: { done in localStops += 1; done(.success(())) },
            retireExternal: { capability, done in
                Task { @MainActor in
                    do { try await assembly.retire(capability); done(.success(())) }
                    catch { done(.failure(error)) }
                }
            })
        var publication: Result<GuguIOSHostBinding, Error>?
        session.publish(ownerId: owner, accessToken: token) { publication = $0 }
        let native = try publication!.get()
        let issued = try session.credentials(expectedBinding: native)
        let binding = GuguPushBinding(ownerId: owner, deviceId: native.deviceId, installationId: installation)
        let platform = RetirementPlatform()
        let client = GuguPushClient(platform: platform, provider: nil,
            currentBinding: { let actual = try session.binding(expectedOwnerId: owner); return .init(ownerId: actual.ownerId, deviceId: actual.deviceId, installationId: actual.installationId) },
            requireOwnerUI: {}, preferences: { .init(chatEnabled: false, taskEnabled: false, chatSoundEnabled: false, taskSoundEnabled: false) },
            foregroundPresentation: { _ in false }, onHint: { _ in })
        assembly = GuguIOSPushRetirement(ownerSession: session, client: client, close: { scope, capability in
            closeCalls += 1
            let original = try session.retirementCredentials(capability, expectedBinding: native)
            guard try original.originalSessionId() == originalSession else { throw GuguPushFailure.stale }
            try session.validateIssuedPushReceipt(issued)
            if mode == "unknown" { throw GuguPushFailure.unavailable }
            return try await GuguIOSPushRetirement.close(configuration: .init(version: 1,
                supabaseUrl: "https://push.invalid", anonKey: "sb_publishable_synthetic"), ownerSession: session,
                capability: capability, scope: scope, send: { request in
                    guard request.url?.path == "/rest/v1/rpc/mobile_push_close_installation",
                          request.value(forHTTPHeaderField: "Authorization") == "Bearer " + token,
                          let body = request.httpBody,
                          let args = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                          args["p_original_session_id"] as? String == originalSession else { throw GuguPushFailure.stale }
                    let response: [String: Any] = ["v": 1, "closed": true,
                        "owner_id": owner, "session_id": mode == "wrong-session" ? owner : originalSession,
                        "installation_id": installation, "device_id": binding.deviceId,
                        "evidence": mode == "absent" ? "session_absent" : "installation_fenced",
                        "fence_id": mode == "absent" ? NSNull() : fence]
                    return (try JSONSerialization.data(withJSONObject: response), HTTPURLResponse(url: request.url!,
                        statusCode: 200, httpVersion: nil, headerFields: nil)!)
                })
        })
        var count = 0
        func check(_ value: Bool, _ label: String) {
            guard value else { print("FAIL \(label)"); exit(1) }; count += 1; print("PASS \(label)")
        }
        func succeeds<T>(_ result: Result<T, Error>) -> Bool { if case .success = result { return true }; return false }
        func prepare() async -> Result<GuguIOSMainWritePermit, Error> {
            await withCheckedContinuation { continuation in session.prepareMainWrite(nextOwnerId: nil) { continuation.resume(returning: $0) } }
        }
        func rejects(_ action: () throws -> Void) -> Bool { do { try action(); return false } catch { return true } }
        mode = "wrong-session"
        let wrong = await prepare()
        check(!succeeds(wrong) && closeCalls == 1 && localStops == 1, "cold memory plus OS denial still requires matching original-session server evidence")
        check(rejects { _ = try session.credentials(expectedBinding: native) }, "wrong close proof leaves ordinary access sealed")
        mode = "unknown"
        let unknown = await prepare()
        check(!succeeds(unknown) && closeCalls == 2 && localStops == 2, "unknown server result blocks storage while local transports still stop")
        mode = "fenced"
        let admitted = await prepare()
        check(succeeds(admitted) && closeCalls == 3 && platform.unregistered == 3 && platform.cleared == 3, "cold denied OS path succeeds only after durable original-scope close")
        try session.commitMainWrite(try admitted.get()) { stored = nil }
        check(try session.snapshot(expectedOwnerId: owner) == nil, "verified cleanup admits and reads back retired storage")
        check(rejects { try session.validateIssuedPushReceipt(issued) }, "original receipt cannot cross committed credential retirement")
        let before = closeCalls
        let fresh = await prepare()
        check(succeeds(fresh) && closeCalls == before, "empty original credential envelope makes no fabricated server-cleanup request")
        try session.commitMainWrite(try fresh.get()) { stored = nil }
        stored = .init(ownerId: owner, accessToken: token, expiresAt: Date().addingTimeInterval(3600))
        session.publish(ownerId: owner, accessToken: token) { publication = $0 }
        mode = "absent"
        let absent = await prepare()
        check(succeeds(absent) && closeCalls == before + 1, "strict original Auth-session absence evidence admits cleanup")
        try session.commitMainWrite(try absent.get()) { stored = nil }
        print("SUMMARY \(count) composed retirement checks; injected storage/OS/server, no actual Keychain/HTTP/APNs/App")
    }
}
