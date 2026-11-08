import Foundation
import CryptoKit

/// Native-only result of the shared JSC envelope projection. It binds the
/// projection back to the picked authoritative inbox row before admission.
struct GuguIOSInboxDelivery {
    let sourceMessageId: String
    let chatId: String
    let prompt: String
    let route: [String: Any]
    let rulesVersion: String?

    init(row: [String: Any], projection: [String: Any]) throws {
        func fail() -> GuguHostFailure { .init(code: "cloud_protocol_error", message: "Projected inbox identity differs from its authoritative source") }
        guard projection["ok"] as? Bool == true, let value = projection["data"] as? [String: Any],
              let id = row["id"] as? String, UUID(uuidString: id) != nil,
              let chat = row["chat_id"] as? String, UUID(uuidString: chat) != nil,
              value["sourceMessageId"] as? String == id, value["chatId"] as? String == chat,
              let seq = row["seq"] as? Int, seq > 0, value["seq"] as? Int == seq,
              let prompt = value["envelope"] as? String, !prompt.isEmpty,
              let route = value["route"] as? [String: Any], route["kind"] as? String == "chat",
              route["sourceMessageId"] as? String == id, route["chatId"] as? String == chat,
              ["text", "system"].contains(row["content_type"] as? String ?? ""),
              row["file_item_id"] is NSNull, row["file_blob_id"] is NSNull else { throw fail() }
        let sender = row["sender_user_id"] as? String
        let thread = row["thread_root_id"] as? String ?? (row["is_thread_root"] as? Bool == true ? id : nil)
        guard route["senderUserId"] as? String == sender, route["threadRootId"] as? String == thread,
              route["whisper"] as? Bool == (row["is_whisper"] as? Bool == true) else { throw fail() }
        var rulesVersion: String?
        if let delivered = value["groupRulesDelivered"] as? [String: Any] {
            guard ["group", "topic"].contains(row["chat_kind"] as? String ?? ""), let text = row["group_rules"] as? String,
                  delivered["chatId"] as? String == chat else { throw fail() }
            let expected = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "none" : String(SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16))
            guard delivered["version"] as? String == expected else { throw fail() }
            rulesVersion = expected
        }
        self.sourceMessageId = id; self.chatId = chat; self.prompt = prompt; self.route = route; self.rulesVersion = rulesVersion
    }
}
