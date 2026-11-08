import Foundation

@main struct PushTransportChecks {
    @MainActor static func main() async throws {
        let owner = "11111111-1111-4111-8111-111111111111", installation = "33333333-3333-4333-8333-333333333333"
        let binding = GuguPushBinding(ownerId: owner, deviceId: "phone-\(installation)-\(owner)", installationId: installation)
        let native = GuguIOSHostBinding(ownerId: owner, deviceId: binding.deviceId, installationId: installation)
        let config = GuguIOSBackendConfiguration(version: 1, supabaseUrl: "https://push.invalid", anonKey: "sb_publishable_synthetic")
        var sends = 0, auths = 0, checked = 0, denyAuthority = false, staleReceipt = false
        var access = "synthetic-access"
        var last: URLRequest?, digest: String?, status = 200, responseBody = "true", alternateURL = false
        let transport = try GuguIOSPushTransport(configuration: config, authorize: { function, hash, actual in
            auths += 1
            guard !denyAuthority, actual == native else { throw GuguHostFailure(code: "stale_context", message: "synthetic") }
            guard ["mobile_push_register", "mobile_push_revoke", "mobile_push_close_installation"].contains(function), hash.count == 64 else { throw GuguHostFailure(code: "invalid_args", message: "synthetic") }
            digest = hash
            return GuguIOSPushAuthority(credentials: .init(binding: native, accessToken: access, expiresAt: Date().addingTimeInterval(3600)), validateReceipt: {
                checked += 1
                if staleReceipt { throw GuguHostFailure(code: "stale_context", message: "synthetic") }
            })
        }, send: { request in
            sends += 1; last = request
            let url = alternateURL ? URL(string: "https://another.invalid")! : request.url!
            return (Data(responseBody.utf8), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        })
        var count = 0
        func check(_ value: Bool, _ label: String) {
            guard value else { print("FAIL \(label)"); exit(1) }; count += 1; print("PASS \(label)")
        }
        func rejects(_ name: String, _ parameters: [String: Any]) async -> Bool {
            do { _ = try await transport.call(name, parameters: parameters, binding: binding); return false } catch { return true }
        }
        let revoke: [String: Any] = ["p_installation_id": installation, "p_registration_id": "55555555-5555-4555-8555-555555555555", "p_generation": "66666666-6666-4666-8666-666666666666"]
        let result = try await transport.call("mobile_push_revoke", parameters: revoke, binding: binding)
        check(result as? Bool == true && sends == 1 && checked == 1, "exact revoke returns a validated JSON receipt")
        check(last?.url?.absoluteString == "https://push.invalid/rest/v1/rpc/mobile_push_revoke" && last?.httpMethod == "POST" && last?.value(forHTTPHeaderField: "Content-Profile") == "identity", "transport uses only packaged HTTPS endpoint and identity schema")
        check(last?.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-access" && last?.value(forHTTPHeaderField: "apikey") == config.anonKey && digest?.count == 64, "native authority binds canonical request digest and headers")
        let before = sends
        check(await rejects("generic_rpc", revoke) && sends == before, "arbitrary RPC is rejected before credential or network access")
        var wrong = revoke; wrong["p_installation_id"] = owner
        check(await rejects("mobile_push_revoke", wrong) && sends == before, "another installation cannot enter the transport")
        wrong = revoke; wrong["p_access_token"] = "synthetic-forbidden"
        check(await rejects("mobile_push_revoke", wrong) && sends == before, "extra credential-shaped parameters are rejected")
        var registration: [String: Any] = ["p_installation_id": installation, "p_device_id": binding.deviceId, "p_token": "00ab", "p_environment": "production", "p_topic": "app.gugu.chat", "p_chat_enabled": true, "p_task_enabled": true, "p_chat_sound_enabled": false, "p_task_sound_enabled": true]
        registration["p_chat_enabled"] = NSNumber(value: 1)
        check(await rejects("mobile_push_register", registration) && sends == before, "numeric permission truthiness cannot issue registration")
        registration["p_chat_enabled"] = true; registration["p_token"] = "00AB"
        check(await rejects("mobile_push_register", registration) && sends == before, "unvalidated APNs token bytes cannot issue registration")
        denyAuthority = true
        check(await rejects("mobile_push_revoke", revoke) && sends == before, "sealed authority issues zero requests")
        denyAuthority = false; staleReceipt = true
        check(await rejects("mobile_push_revoke", revoke) && sends == before + 1, "account transition prevents receipt delivery after real I/O boundary")
        staleReceipt = false; status = 401
        check(await rejects("mobile_push_revoke", revoke), "authentication HTTP failure is not successful cleanup")
        status = 200; alternateURL = true
        check(await rejects("mobile_push_revoke", revoke), "unexpected redirect response is rejected")
        alternateURL = false; responseBody = "not-json"
        check(await rejects("mobile_push_revoke", revoke), "malformed server response remains unknown")
        let session = "77777777-7777-4777-8777-777777777777"
        let payload = try JSONSerialization.data(withJSONObject: ["sub": owner, "session_id": session]).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        access = "synthetic." + payload + ".signature"; responseBody = "{\"closed\":true}"
        let close: [String: Any] = ["p_installation_id": installation, "p_device_id": binding.deviceId, "p_original_session_id": session]
        let closed = try await transport.call("mobile_push_close_installation", parameters: close, binding: binding)
        check((closed as? [String: Any])?["closed"] as? Bool == true, "close uses only the session projected from its native credential")
        let beforeClose = sends
        var wrongClose = close; wrongClose["p_original_session_id"] = owner
        check(await rejects("mobile_push_close_installation", wrongClose) && sends == beforeClose, "another Auth session cannot be closed with the old credential")
        access = "synthetic-invalid"
        check(await rejects("mobile_push_close_installation", close) && sends == beforeClose, "missing JWT session scope issues zero close requests")
        print("SUMMARY \(count) injected transport checks; zero real HTTP/APNs/Keychain/App")
        _ = auths
    }
}
