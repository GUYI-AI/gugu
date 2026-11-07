import Foundation

let owner = "11111111-1111-4111-8111-111111111111"
var count = 0
func expect(_ value: @autoclosure () throws -> Bool, _ label: String) {
    do { guard try value() else { print("FAIL \(label)"); exit(1) }; count += 1; print("PASS \(label)") }
    catch { print("FAIL \(label)"); exit(1) }
}
func rejects(_ body: () throws -> Void) -> Bool { do { try body(); return false } catch { return true } }
func envelope(subject: String = owner, storedExpiry: Double = 5000, claimExpiry: Double = 2000) throws -> Data {
    let payload = try JSONSerialization.data(withJSONObject: ["sub": subject, "exp": claimExpiry]).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    let raw = try JSONSerialization.data(withJSONObject: ["user": ["id": owner], "access_token": "fixture.\(payload).signature", "expires_at": storedExpiry, "refresh_token": "unused-fixture-refresh"])
    return try JSONSerialization.data(withJSONObject: ["state": "SESSION", "raw": String(decoding: raw, as: UTF8.self)])
}
let data = try envelope()
expect(try GuguIOSOwnerKeychain.decode(data)?.ownerId == owner, "projects only the main owner")
expect(try GuguIOSOwnerKeychain.decode(data)?.expiresAt == Date(timeIntervalSince1970: 2000), "stored expiry is bounded by the decoded JWT claim")
expect(try GuguIOSOwnerKeychain.ownerForMainWrite(String(decoding: data, as: UTF8.self)) == owner, "pre-write identity uses the same envelope")
expect(try GuguIOSOwnerKeychain.decode(Data("{\"state\":\"RETIRED_EMPTY\"}".utf8)) == nil, "retired record has no native session")
expect(rejects { _ = try GuguIOSOwnerKeychain.decode(envelope(subject: "22222222-2222-4222-8222-222222222222")) }, "claims must match stored owner")
expect(rejects { _ = try GuguIOSOwnerKeychain.decode(Data("{\"state\":\"SESSION\",\"raw\":\"broken\"}".utf8)) }, "damaged session is not an anonymous success")
expect(rejects { _ = try GuguIOSOwnerKeychain.decode(envelope(claimExpiry: -1)) }, "invalid expiry rejected")
expect(rejects { _ = try GuguIOSOwnerKeychain.ownerForMainWrite("{\"state\":\"UNKNOWN\"}") }, "unsupported retirement envelope rejected")
expect(rejects { _ = try GuguIOSOwnerKeychain.decode(Data("{\"state\":\"RETIRED_EMPTY\",\"raw\":\"unexpected\"}".utf8)) }, "ambiguous retirement envelope is not an anonymous success")
var extended = try JSONSerialization.jsonObject(with: data) as! [String: Any]
extended["extra"] = true
expect(rejects { _ = try GuguIOSOwnerKeychain.decode(JSONSerialization.data(withJSONObject: extended)) }, "main envelope matches the renderer exact-field contract")
let config = GuguIOSBackendConfiguration(version: 1, supabaseUrl: "https://backend.invalid/prefix", anonKey: "public-fixture")
expect(try config.baseURL().appendingPathComponent("auth/v1/user").absoluteString == "https://backend.invalid/prefix/auth/v1/user", "auth path stays on the packaged backend")
expect(rejects { _ = try GuguIOSBackendConfiguration(version: 1, supabaseUrl: "http://backend.invalid", anonKey: "public-fixture").baseURL() }, "no insecure backend fallback")
expect(rejects { _ = try GuguIOSBackendConfiguration(version: 1, supabaseUrl: "https://backend.invalid?url=elsewhere", anonKey: "public-fixture").baseURL() }, "backend query override rejected")
expect(rejects { _ = try GuguIOSBackendConfiguration(version: 1, supabaseUrl: "https://backend.invalid", anonKey: "fixture\nheader").baseURL() }, "invalid header input rejected")
print("SUMMARY \(count) decoding/config checks; no real Keychain, HTTP, model or App calls")
