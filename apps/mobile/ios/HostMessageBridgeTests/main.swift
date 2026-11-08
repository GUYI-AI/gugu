import Foundation

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "message_bridge_test_failed", message: text) }
}
private func wait(_ work: (@escaping ([String: Any]) -> Void) -> Void) throws -> [String: Any] {
    let semaphore = DispatchSemaphore(value: 0); var outcome: [String: Any]?
    work { outcome = $0; semaphore.signal() }
    try require(semaphore.wait(timeout: .now() + 10) == .success, "Native message callback timed out"); return outcome!
}
private final class Fixture {
    let binding: GuguIOSHostBinding, context: GuguHostContext, store: GuguIOSBackendStore
    let chat = UUID().uuidString.lowercased(), source = UUID().uuidString.lowercased(), recipient = UUID().uuidString.lowercased(), thread = UUID().uuidString.lowercased()
    var allowed = true, sourceMember = true, moved = false, rules = "Preserve privacy", loseACK = true, writes = 0, sendIDs: [String] = [], requestBodies: [[String: Any]] = [], messages: Set<String> = []
    var calendarAllowed = true, revokeAfterSend = false
    init(_ root: URL) throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        context = .init(ownerId: owner, installationId: install, agentUserId: UUID().uuidString.lowercased(), sessionId: UUID().uuidString.lowercased(), jobId: UUID().uuidString.lowercased(), contextEpoch: UUID().uuidString.lowercased(), runtimeInstanceId: UUID().uuidString.lowercased())
        store = try .init(root: root, binding: binding)
        _ = try store.admit("inputs", id: context.jobId, fingerprint: "fixture") { ["agentId": context.agentUserId, "sessionId": context.sessionId, "contextEpoch": context.contextEpoch, "status": "running", "route": ["chatId": chat, "threadRootId": thread], "usedChatIds": [source]] }
    }
    lazy var broker = try! GuguIOSCloudBroker(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
        guard self.allowed, expected == self.binding else { throw GuguHostFailure(code: "stale_context", message: "Native synthetic publication retired") }
        return .init(binding: expected, accessToken: "synthetic-native-only", expiresAt: Date().addingTimeInterval(3600))
    }, send: { request, done in
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:], name = request.url!.lastPathComponent
        self.requestBodies.append(body); var value: Any = NSNull()
        switch name {
        case "active_users": value = [["id": self.context.agentUserId, "type": "agent", "owner_user_id": self.binding.ownerId, "device_id": self.moved ? "another-device" : self.binding.deviceId]]
        case "list_member_ids": value = body["p_chat_id"] as? String == self.source && !self.sourceMember ? [] : [["user_id": self.context.agentUserId], ["user_id": self.recipient]]
        case "chat_facts": value = [["id": self.chat, "kind": "group", "group_prompt": self.rules]]
        case "message_history_as": value = [["id": UUID().uuidString.lowercased(), "sender_user_id": self.recipient, "content": "Synthetic private agent-visible history"]]
        case "send_message_idempotent":
            let id = body["p_message_id"] as! String; self.sendIDs.append(id)
            if self.messages.insert(id).inserted { self.writes += 1 }
            if self.revokeAfterSend { self.calendarAllowed = false }
            value = [["id": id]]
            if self.loseACK { self.loseACK = false; done(nil, nil, URLError(.networkConnectionLost)); return }
        default: break
        }
        done(try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
    })
    func bridge() -> GuguIOSMessageBridge { .init(store: store, broker: broker, check: { guard self.allowed else { throw GuguHostFailure(code: "stale_context", message: "Synthetic native context retired") } }) }
    func invoke(_ bridge: GuguIOSMessageBridge, _ name: String, _ args: [String: Any]) throws -> [String: Any] {
        try wait { bridge.invoke(context: context, name: name, args: args, authorize: { guard self.allowed, self.calendarAllowed else { throw GuguHostFailure(code: "not_granted", message: "Synthetic calendar source revoked") } }, completion: $0) }
    }
}
@main struct HostMessageBridgeTests {
    static func main() throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), f = try Fixture(root.appendingPathComponent("outbox")), bridge = f.bridge()
        let args: [String: Any] = ["chat_id": f.chat, "text": "Synthetic original reply", "to_user_ids": ["user:\(f.recipient)"], "reply_to_message_id": "msg:\(UUID().uuidString.lowercased())"]
        let beforeRules = try f.invoke(bridge, "message_send", args)
        try require(beforeRules["code"] as? String == "not_granted" && f.writes == 0, "Unread group rules did not block write")
        var cases = ["current_group_rules_required_before_outbox_admission"]
        let golden = try GuguIOSStableID.values(["phone-message", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "中文 / quote \" and newline\n🙂", ["44444444-4444-4444-8444-444444444444"], "msg:55555555-5555-4555-8555-555555555555", false])
        try require(golden == "de434964-9179-5448-a44d-f9ad8f8d8198", "Native message identity differs from Android JSON.stringify/SHA256 vector")
        cases.append("Unicode_recipient_reply_and_boolean_stable_ID_matches_Android_golden_vector")
        let rules = try f.invoke(bridge, "message_rules", ["chat_id": f.chat]); try require(rules["ok"] as? Bool == true, "Rules read failed")
        let unknown = try f.invoke(bridge, "message_send", args)
        try require(unknown["code"] as? String == "cloud_transport_uncertain" && f.writes == 1, "Lost send ACK did not retain uncertain single effect")
        let firstID = f.sendIDs.first!, record = try f.store.record("outbox", id: firstID)
        try require(record?["status"] as? String == "pending" && ((record?["body"] as? [String: Any])?["p_thread_root_id"] as? String) == f.thread, "Unknown send lost original stable ID or source thread")
        // A new facade never sends automatically. Explicitly repeat the same tool.
        let reopened = f.bridge(); try require(f.sendIDs.count == 1, "Reopening outbox replayed unknown write")
        let known = try f.invoke(reopened, "message_send", args)
        try require(known["ok"] as? Bool == true && f.sendIDs == [firstID, firstID] && f.writes == 1, "Explicit retry generated another message effect")
        let cached = try f.invoke(reopened, "message_send", args)
        try require(cached["ok"] as? Bool == true && f.sendIDs.count == 2, "Completed outbox replay wrote again")
        cases.append("lost_ACK_preserves_thread_and_Android_stable_ID_without_automatic_replay")
        f.rules = "Changed privacy rule"
        let changed = try f.invoke(reopened, "message_send", args)
        try require(changed["code"] as? String == "not_granted" && f.sendIDs.count == 2, "Changed group rule was bypassed by cached receipt")
        _ = try f.invoke(reopened, "message_rules", ["chat_id": f.chat])
        f.sourceMember = false
        let revoked = try f.invoke(reopened, "message_send", args)
        try require(revoked["code"] as? String == "not_granted" && f.sendIDs.count == 2, "Revoked source membership leaked saved result")
        cases.append("changed_rules_and_revoked_source_membership_block_cached_reply_delivery")
        f.sourceMember = true
        let history = try f.invoke(reopened, "message_history", ["chat_id": f.chat])
        let data = history["data"] as? [[String: Any]]
        try require(history["ok"] as? Bool == true && data?.first?["sender_user_id"] as? String == "user:\(f.recipient)" && (data?.first?["id"] as? String)?.hasPrefix("msg:") == true, "Agent-as history lacked typed addresses")
        try require(f.requestBodies.filter { $0["p_as_user_id"] != nil }.allSatisfy { $0["p_as_user_id"] as? String == f.context.agentUserId }, "Owner JWT broadened agent-as reads")
        cases.append("history_uses_native_Agent_identity_and_returns_typed_addresses")
        f.moved = true
        let moved = try f.invoke(reopened, "message_send", args)
        try require(moved["code"] as? String == "not_granted" && f.sendIDs.count == 2, "Moved Agent identity reused old native outbox")
        f.moved = false
        cases.append("moved_cloud_Agent_cannot_reuse_old_native_message_custody")
        f.allowed = false
        let sealed = try f.invoke(reopened, "message_send", args)
        try require(sealed["ok"] as? Bool != true && f.sendIDs.count == 2, "Retired native context sent protected text")
        let contents = String(decoding: try Data(contentsOf: root.appendingPathComponent("outbox/\(f.binding.ownerId)/backend.json")), as: UTF8.self)
        try require(!contents.contains("synthetic-native-only"), "Native human credential entered outbox")
        cases.append("retired_context_is_rejected_and_credentials_are_absent_from_outbox")
        let late = try Fixture(root.appendingPathComponent("late-source-revoke")); late.loseACK = false
        let lateBridge = late.bridge(); _ = try late.invoke(lateBridge, "message_rules", ["chat_id": late.chat]); late.revokeAfterSend = true
        let withheld = try late.invoke(lateBridge, "message_send", ["chat_id": late.chat, "text": "Synthetic late revoke", "to_user_ids": ["user:\(late.recipient)"]])
        try require(withheld["code"] as? String == "not_granted" && late.writes == 1, "Late source revocation leaked result or prevented known write fixture")
        try require(try late.store.record("outbox", id: late.sendIDs.first!)?["status"] as? String == "sent", "Known message receipt was lost before post-write permission check")
        cases.append("late_source_revocation_withholds_result_but_preserves_known_write_receipt")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "native_message_outbox_APFS_with_synthetic_agent_as_HTTP", "cases": cases, "realCloudHTTPCalls": 0, "realMessagesSent": 0, "realModelCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
