import Foundation
import Testing
@testable import GuguPushNotifications

@MainActor private final class Transport: GuguPushRPCTransport {
    var function = "", parameters: [String: Any] = [:], calls = 0
    var binding: GuguPushBinding?
    var result: Any = ["registration_id": "55555555-5555-4555-8555-555555555555", "generation": "66666666-6666-4666-8666-666666666666"]
    func call(_ function: String, parameters: [String: Any], binding: GuguPushBinding) async throws -> Any {
        calls += 1; self.function = function; self.parameters = parameters; self.binding = binding; return result
    }
}

@Suite @MainActor struct GuguPushRPCProviderTests {
    private let binding = GuguPushBinding(ownerId: "11111111-1111-4111-8111-111111111111",
        deviceId: "phone-33333333-3333-4333-8333-333333333333-11111111-1111-4111-8111-111111111111",
        installationId: "33333333-3333-4333-8333-333333333333")
    private func request(_ data: Data = Data([0, 1, 255])) -> GuguPushRegistrationRequest {
        .init(ticket: .init(binding: binding, generation: UUID()),
              preferences: .init(chatEnabled: true, taskEnabled: false, chatSoundEnabled: false, taskSoundEnabled: false), deviceToken: data)
    }
    @Test func exactWireMappingUsesSignedEnvironmentAndServerGeneration() async throws {
        let transport = Transport(), request = request()
        let provider = GuguPushRPCProvider(transport: transport, environment: .production)
        let ack = try await provider.register(request)
        #expect(transport.function == "mobile_push_register")
        #expect(Set(transport.parameters.keys) == ["p_installation_id", "p_device_id", "p_token", "p_environment", "p_topic", "p_chat_enabled", "p_task_enabled", "p_chat_sound_enabled", "p_task_sound_enabled"])
        #expect(transport.parameters["p_token"] as? String == "0001ff")
        #expect(transport.parameters["p_environment"] as? String == "production")
        #expect(transport.parameters["p_topic"] as? String == "app.gugu.chat")
        #expect(ack.ticket == request.ticket && ack.serverGeneration != request.ticket.generation)
        #expect(ack.serverGeneration.uuidString.lowercased() == "66666666-6666-4666-8666-666666666666")
    }
    @Test(arguments: [false, true]) func independentSoundsAreSentWithoutMerging(chatSound: Bool) async throws {
        let t = Transport(), provider = GuguPushRPCProvider(transport: t, environment: .production)
        let request = GuguPushRegistrationRequest(ticket: .init(binding: binding, generation: UUID()),
            preferences: .init(chatEnabled: true, taskEnabled: true, chatSoundEnabled: chatSound, taskSoundEnabled: !chatSound),
            deviceToken: Data([0, 1]))
        let receipt = try await provider.register(request)
        #expect(t.parameters.count == 9 && t.parameters["p_sound_enabled"] == nil)
        #expect(t.parameters["p_chat_sound_enabled"] as? Bool == chatSound)
        #expect(t.parameters["p_task_sound_enabled"] as? Bool == !chatSound)
        #expect(receipt.preferences == request.preferences)
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
    private var scope: GuguPushRetirementScope {
        .init(binding: binding, originalSessionId: "77777777-7777-4777-8777-777777777777")
    }
    private func closeReply(_ kind: String = "installation_fenced") -> [String: Any] {
        ["v": 1, "closed": true, "evidence": kind, "owner_id": binding.ownerId,
         "session_id": scope.originalSessionId, "installation_id": binding.installationId,
         "device_id": binding.deviceId,
         "fence_id": kind == "installation_fenced" ? "99999999-9999-4999-8999-999999999999" : NSNull()]
    }
    @Test(arguments: ["installation_fenced", "session_absent"])
    func closeUsesOriginalScopeAndAcceptsOnlyTypedEvidence(kind: String) async throws {
        let t = Transport(), provider = GuguPushRPCProvider(transport: t, environment: .production)
        t.result = closeReply(kind)
        let proof = try await provider.closeInstallation(scope: scope)
        #expect(t.function == "mobile_push_close_installation" && t.binding == binding)
        #expect(Set(t.parameters.keys) == ["p_installation_id", "p_device_id", "p_original_session_id"])
        #expect(t.parameters["p_original_session_id"] as? String == scope.originalSessionId)
        #expect(t.parameters["p_device_id"] as? String == binding.deviceId)
        #expect(t.parameters["p_installation_id"] as? String == binding.installationId)
        #expect(proof.scope == scope && proof.kind.rawValue == kind)
        #expect((kind == "session_absent") == (proof.fenceId == nil))
    }
    @Test func retirementOnlyProviderNeedsNoAPNsEnvironmentAndAllowsOnlyClose() async throws {
        let t = Transport()
        let provider = GuguPushRPCProvider(retirementTransport: t)
        let registration = request()
        do { _ = try await provider.register(registration); Issue.record("Expected registration rejection") }
        catch let e as GuguPushFailure { #expect(e.code == "backend_unavailable") }
        let ack = GuguPushRegistrationReceipt(ticket: registration.ticket, registrationId: "55555555-5555-4555-8555-555555555555",
            serverGeneration: UUID(), preferences: registration.preferences)
        let closeOnly = GuguPushRPCProvider(retirementTransport: t)
        do { _ = try await closeOnly.revoke(.init(receipt: ack)); Issue.record("Expected ordinary revoke rejection") }
        catch let e as GuguPushFailure { #expect(e.code == "backend_unavailable") }
        #expect(t.calls == 0)
        t.result = closeReply()
        let proof = try await closeOnly.closeInstallation(scope: scope)
        #expect(proof.scope == scope && proof.kind == .installationFenced)
        #expect(t.calls == 1 && t.function == "mobile_push_close_installation")
        #expect(t.parameters["p_environment"] == nil && t.parameters["p_token"] == nil)
    }
    @Test(arguments: ["boolVersion", "stringVersion", "falseClosed", "numericClosed", "null", "missingFence", "emptyFence", "badFence", "nullFence", "absentWithFence", "owner", "session", "installation", "device", "kind"])
    func invalidCloseEvidenceNeverReleasesBarrier(field: String) async {
        let t = Transport(), provider = GuguPushRPCProvider(transport: t, environment: .sandbox)
        var reply = closeReply()
        switch field {
        case "boolVersion": reply["v"] = true
        case "stringVersion": reply["v"] = "1"
        case "falseClosed": reply["closed"] = false
        case "numericClosed": reply["closed"] = 1
        case "missingFence": reply.removeValue(forKey: "fence_id")
        case "emptyFence": reply["fence_id"] = ""
        case "badFence": reply["fence_id"] = "not-a-fence"
        case "nullFence": reply["fence_id"] = NSNull()
        case "absentWithFence": reply["evidence"] = "session_absent"
        case "owner": reply["owner_id"] = UUID().uuidString.lowercased()
        case "session": reply["session_id"] = UUID().uuidString.lowercased()
        case "installation": reply["installation_id"] = UUID().uuidString.lowercased()
        case "device": reply["device_id"] = "another-device"
        case "kind": reply["evidence"] = "never_registered"
        default: break
        }
        t.result = field == "null" ? NSNull() : reply
        do { _ = try await provider.closeInstallation(scope: scope); Issue.record("Expected close evidence rejection") }
        catch let e as GuguPushFailure { #expect(e.code == "revocation_unknown") }
        catch { Issue.record("Expected sanitized close failure") }
    }
    @Test func malformedNativeSessionRejectsBeforeTransport() async {
        let t = Transport(), provider = GuguPushRPCProvider(transport: t, environment: .sandbox)
        do {
            _ = try await provider.closeInstallation(scope: .init(binding: binding, originalSessionId: "not-a-session"))
            Issue.record("Expected native scope rejection")
        } catch let e as GuguPushFailure { #expect(e.code == "stale_context") }
        catch { Issue.record("Expected native scope failure") }
        #expect(t.calls == 0)
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
