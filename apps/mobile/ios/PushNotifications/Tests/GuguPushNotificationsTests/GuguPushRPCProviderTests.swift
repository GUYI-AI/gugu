import Foundation
import Testing
@testable import GuguPushNotifications

@MainActor private final class Transport: GuguPushRPCTransport {
    var function = "", parameters: [String: Any] = [:], calls = 0
    var result: Any = ["registration_id": "55555555-5555-4555-8555-555555555555", "generation": "66666666-6666-4666-8666-666666666666"]
    func call(_ function: String, parameters: [String: Any], binding: GuguPushBinding) async throws -> Any {
        calls += 1; self.function = function; self.parameters = parameters; return result
    }
}

@Suite @MainActor struct GuguPushRPCProviderTests {
    private let binding = GuguPushBinding(ownerId: "11111111-1111-4111-8111-111111111111",
        deviceId: "phone-33333333-3333-4333-8333-333333333333-11111111-1111-4111-8111-111111111111",
        installationId: "33333333-3333-4333-8333-333333333333")
    private func request(_ data: Data = Data([0, 1, 255])) -> GuguPushRegistrationRequest {
        .init(ticket: .init(binding: binding, generation: UUID()),
              preferences: .init(chatEnabled: true, taskEnabled: false, soundEnabled: false), deviceToken: data)
    }
    @Test func exactWireMappingUsesSignedEnvironmentAndServerGeneration() async throws {
        let transport = Transport(), request = request()
        let provider = GuguPushRPCProvider(transport: transport, environment: .production)
        let ack = try await provider.register(request)
        #expect(transport.function == "mobile_push_register")
        #expect(Set(transport.parameters.keys) == ["p_installation_id", "p_device_id", "p_token", "p_environment", "p_topic", "p_chat_enabled", "p_task_enabled", "p_sound_enabled"])
        #expect(transport.parameters["p_token"] as? String == "0001ff")
        #expect(transport.parameters["p_environment"] as? String == "production")
        #expect(transport.parameters["p_topic"] as? String == "app.gugu.chat")
        #expect(ack.ticket == request.ticket && ack.serverGeneration != request.ticket.generation)
        #expect(ack.serverGeneration.uuidString.lowercased() == "66666666-6666-4666-8666-666666666666")
    }
    @Test func tokenLimitCountsHexCharactersAndPreservesAllBytes() async throws {
        let t = Transport(), p = GuguPushRPCProvider(transport: Transport(), environment: .sandbox)
        let provider = GuguPushRPCProvider(transport: t, environment: .sandbox)
        _ = try await provider.register(request(Data(repeating: 255, count: 2048)))
        #expect((t.parameters["p_token"] as? String)?.count == 4096)
        do { _ = try await p.register(request(Data(repeating: 255, count: 2049))); Issue.record("Expected token rejection") }
        catch let e as GuguPushFailure { #expect(e.code == "invalid_args") }
    }
    @Test func revokeUsesExactServerReceiptAndFalseIsPreserved() async throws {
        let t = Transport(), p = GuguPushRPCProvider(transport: Transport(), environment: .sandbox)
        let ack = try await p.register(request())
        let provider = GuguPushRPCProvider(transport: t, environment: .sandbox)
        t.result = false
        #expect(try await !provider.revoke(.init(receipt: ack)))
        #expect(t.function == "mobile_push_revoke")
        #expect(Set(t.parameters.keys) == ["p_installation_id", "p_registration_id", "p_generation"])
        #expect(t.parameters["p_generation"] as? String == ack.serverGeneration.uuidString.lowercased())
    }
    @Test(arguments: ["string", "number", "null"]) func revokeRejectsTruthyNonBoolean(kind: String) async throws {
        let t = Transport(), provider = GuguPushRPCProvider(transport: t, environment: .sandbox)
        let ack = try await provider.register(request())
        switch kind { case "string": t.result = "true"; case "number": t.result = 1; default: t.result = NSNull() }
        do { _ = try await provider.revoke(.init(receipt: ack)); Issue.record("Expected strict boolean rejection") }
        catch let e as GuguPushFailure { #expect(e.code == "revocation_unknown") }
    }
    private func payload() -> [AnyHashable: Any] {
        ["aps": ["alert": ["body": "Generic reminder"]], "gugu": ["v": 1,
         "ownerId": binding.ownerId, "installationId": binding.installationId,
         "registrationId": "55555555-5555-4555-8555-555555555555", "generation": "66666666-6666-4666-8666-666666666666",
         "notificationId": "77777777-7777-4777-8777-777777777777", "kind": "chat_message", "revision": "9223372036854775807",
         "chatId": "not a navigation command", "url": "never forwarded"]]
    }
    @Test func payloadParsesOnlyFrozenIdentifiersAndDecimalRevision() {
        let decoded = GuguPushPayload.decode(payload())
        #expect(decoded?.binding == binding && decoded?.kind == .chatMessage)
        #expect(decoded?.revision == "9223372036854775807")
    }
    @Test(arguments: ["booleanVersion", "stringVersion", "owner", "registration", "generation", "kind", "numericRevision", "overflow", "negative", "leadingZero"])
    func malformedPayloadIsRejected(field: String) {
        var value = payload(), object = value["gugu"] as! [String: Any]
        switch field {
        case "booleanVersion": object["v"] = true
        case "stringVersion": object["v"] = "1"
        case "owner": object["ownerId"] = "not-an-owner"
        case "registration": object["registrationId"] = "not-a-registration"
        case "generation": object["generation"] = "bad"
        case "kind": object["kind"] = "execute_tool"
        case "numericRevision": object["revision"] = 12
        case "overflow": object["revision"] = "9223372036854775808"
        case "negative": object["revision"] = "-1"
        default: object["revision"] = "01"
        }
        value["gugu"] = object
        #expect(GuguPushPayload.decode(value) == nil)
    }
}
