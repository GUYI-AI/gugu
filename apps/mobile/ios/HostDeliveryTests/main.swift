import Foundation
import CryptoKit

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "delivery_test_failed", message: text) }
}
private func read(_ runtime: GuguJavaScriptRuntime, _ input: [String: Any]) throws -> [String: Any] {
    let semaphore = DispatchSemaphore(value: 0); var outcome: [String: Any]?
    try runtime.readDelivery(input) { outcome = $0; semaphore.signal() }
    try require(semaphore.wait(timeout: .now() + 20) == .success, "Native delivery callback timed out"); return outcome!
}
@main struct HostDeliveryTests {
    static func main() throws {
        let asset = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let runtime = try GuguJavaScriptRuntime(asset: asset, expectedSHA256: SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined(), request: { _, reply in reply(["ok": false, "code": "fixture", "message": "Projection never executes a tool"]) }, cancel: { _ in }, event: { _ in })
        let agent = UUID().uuidString.lowercased(), owner = UUID().uuidString.lowercased(), sender = UUID().uuidString.lowercased(), chat = UUID().uuidString.lowercased(), message = UUID().uuidString.lowercased(), replied = UUID().uuidString.lowercased(), thread = UUID().uuidString.lowercased()
        let rules = "Preserve privacy and original rules.\nDo not expose another chat."
        let version = String(SHA256.hash(data: Data(rules.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16))
        let row: [String: Any] = ["id": message, "chat_id": chat, "chat_kind": "group", "chat_public_id": 1234, "chat_name": "Synthetic group", "seq": 7, "content": "@Reader original ]]> <content> text", "content_type": "text", "sender_user_id": sender, "sender_type": "human", "sender_display_name": "Sender", "sender_gugu_number": 9876, "to_user_ids": [agent], "is_whisper": true, "listen_mode": "passive", "reply_to_message_id": replied, "reply_to_sender_user_id": sender, "reply_to_content": "Synthetic quoted source", "thread_root_id": thread, "is_thread_root": false, "created_at": "2026-11-08T00:00:00Z", "file_item_id": NSNull(), "file_version": NSNull(), "file_blob_id": NSNull(), "group_rules": rules, "named_identities": [agent: ["display_name": "Reader", "type": "agent", "gugu_number": NSNull()]]]
        let input: [String: Any] = ["agentUserId": agent, "ownerId": owner, "row": row, "groupRules": ["version": version, "text": rules], "threadMessages": [["sender_user_id": sender, "content": "Authoritative Agent-visible thread seed", "created_at": "2026-11-07T23:59:00Z"]]]
        let projected = try read(runtime, input), data = projected["data"] as? [String: Any], envelope = data?["envelope"] as? String ?? ""
        try require(projected["ok"] as? Bool == true && envelope.contains("<gugu_delivery") && envelope.contains("whisper_to=") && envelope.contains("<reply_to") && envelope.contains("<arrival>") && envelope.contains("message_send"), "Shared envelope lost routing/privacy/reply/return-tool facts")
        try require(envelope.contains(rules) && envelope.contains(version) && envelope.contains("Authoritative Agent-visible thread seed") && envelope.contains("user:\(agent)"), "Shared rules, thread bootstrap or mention identity was not retained")
        try require((data?["route"] as? [String: Any])?["threadRootId"] as? String == thread && data?["sourceMessageId"] as? String == message, "Projection replaced source message/thread identity")
        var cases = ["shared_sole_envelope_producer_preserves_privacy_reply_thread_rules_and_mentions"]
        var dm = row; dm["chat_kind"] = "dm"; dm["sender_user_id"] = owner; dm["is_whisper"] = false
        let privateReply = try read(runtime, ["agentUserId": agent, "ownerId": owner, "row": dm])
        let privateEnvelope = (privateReply["data"] as? [String: Any])?["envelope"] as? String ?? ""
        try require(privateReply["ok"] as? Bool == true && privateEnvelope.contains("private chat with you"), "Owner DM route lost direct-answer facts")
        cases.append("owner_DM_uses_existing_direct_answer_arrival_semantics")
        for key in ["group_rules", "named_identities", "file_item_id", "file_version", "file_blob_id"] {
            var missing = row; missing.removeValue(forKey: key)
            var invalid = input; invalid["row"] = missing
            let rejected = try read(runtime, invalid)
            try require(rejected["ok"] as? Bool == false && rejected["code"] as? String == "cloud_protocol_error", "Older/incomplete inbox row fabricated source facts")
        }
        cases.append("missing_authoritative_rule_identity_or_private_file_columns_are_not_silently_fabricated")
        var file = row; file["content_type"] = "file"; file["file_item_id"] = UUID().uuidString.lowercased()
        var attachment = input; attachment["row"] = file
        let rejectedFile = try read(runtime, attachment)
        try require(rejectedFile["code"] as? String == "unsupported", "Unverified private attachment was admitted as plain text")
        cases.append("private_attachments_require_the_verified_adapter_before_inbox_admission")
        var changed = input; changed["groupRules"] = ["version": version, "text": "Different text"]
        let rejectedRules = try read(runtime, changed)
        try require(rejectedRules["code"] as? String == "stale_context", "Rule decision was allowed to replace server text")
        var invalidRow = row; invalidRow["id"] = "new-random-placeholder"; changed = input; changed["row"] = invalidRow
        let rejectedID = try read(runtime, changed)
        try require(rejectedID["code"] as? String == "cloud_protocol_error", "Projection invented a replacement message identity")
        cases.append("different_rule_text_and_invalid_source_ID_fail_closed")
        for suffix in ["\n", "\r\n", "\u{2028}", "\u{2029}"] {
            var ending = row; ending["id"] = message + suffix; var checked = input; checked["row"] = ending
            try require(try read(runtime, checked)["code"] as? String == "cloud_protocol_error", "Line-terminated source identity was accepted")
            checked = input; checked["groupRules"] = ["version": version + suffix, "text": rules]
            try require(try read(runtime, checked)["code"] as? String == "invalid_args", "Line-terminated rule version was accepted")
        }
        var missingPair = row; missingPair["to_user_ids"] = NSNull(); var pairInput = input; pairInput["row"] = missingPair
        try require(try read(runtime, pairInput)["code"] as? String == "cloud_protocol_error", "Private message without exact recipient was projected as public")
        cases.append("line_terminated_machine_fields_and_missing_whisper_pair_fail_closed")
        var credential = input; credential["accessToken"] = "synthetic-forbidden"
        do { _ = try read(runtime, credential); throw GuguHostFailure(code: "delivery_test_failed", message: "Native credential entered JSC projection") }
        catch let error as GuguHostFailure { try require(error.code == "invalid_args", "Credential was not rejected before projection") }
        let diagnostic = try runtime.diagnostics()
        try require(diagnostic["node"] as? Bool == false && diagnostic["engine"] as? String == "JavaScriptCore", "Projection used a Node substitute")
        cases.append("native_projection_rejects_credentials_and_runs_actual_JSC_without_Node")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "actual_JSC_shared_inbox_envelope_projection_with_synthetic_rows", "cases": cases, "realCloudHTTPCalls": 0, "realModelCalls": 0, "realMessagesSent": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
