import Foundation
import CryptoKit
import CoreFoundation

/// Agent-as chat reads and the Android stable-ID outbox. Its native caller must
/// guard the exact live Pi context and calendar-derived data on every callback.
/// No background replay runs when this object is constructed or a file is read.
final class GuguIOSMessageBridge {
    typealias Authorize = () throws -> Void
    private let queue = DispatchQueue(label: "app.gugu.ios.message-bridge")
    private let store: GuguIOSBackendStore
    private let broker: GuguIOSCloudBroker
    private let check: Authorize
    private let sources: GuguIOSSourceAccess
    init(store: GuguIOSBackendStore, broker: GuguIOSCloudBroker, check: @escaping Authorize) {
        self.store = store; self.broker = broker; self.check = check
        sources = GuguIOSSourceAccess(store: store, broker: broker, check: check)
    }

    /// A plain final answer to an admitted chat source uses the same guarded
    /// outbox as an explicit communication tool. Unknown sends are never replayed
    /// or replaced by another final message when a task/process finishes again.
    func finish(context: GuguHostContext, text: String, authorize: @escaping Authorize,
                completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            do {
                try self.validate(context); try authorize()
                guard let input = try self.store.record("inputs", id: context.jobId) else {
                    throw Self.failure("stale_context", "Final answer has no original durable input")
                }
                guard let route = input["route"] as? [String: Any], route["kind"] as? String == "chat" else {
                    completion(["ok": true, "data": ["chatDelivery": false]]); return
                }
                let rows = try self.store.snapshot()["outbox"] as? [String: [String: Any]] ?? [:]
                var sent = false
                for row in rows.values {
                    guard let raw = row["context"] as? [String: Any] else { throw Self.failure("invalid_journal", "Outbound message context is missing") }
                    let saved = try GuguHostJournal.context(raw)
                    guard saved.jobId == context.jobId, saved.agentUserId == context.agentUserId,
                          saved.sessionId == context.sessionId, saved.contextEpoch == context.contextEpoch else { continue }
                    guard row["status"] as? String == "sent", row["receipt"] is [String: Any] else {
                        throw Self.failure("delivery_uncertain", "An original outbound message has no confirmed delivery; it will not be replaced or automatically replayed")
                    }
                    let body = row["body"] as? [String: Any]
                    if body?["p_chat_id"] as? String == route["chatId"] as? String,
                       body?["p_reply_to_message_id"] as? String == route["sourceMessageId"] as? String,
                       body?["p_is_whisper"] as? Bool == (route["whisper"] as? Bool == true) { sent = true }
                }
                let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if sent || text == "[NO_REPLY]" { completion(["ok": true, "data": ["chatDelivery": sent]]); return }
                guard !text.isEmpty, let chat = route["chatId"] as? String, UUID(uuidString: chat) != nil,
                      let source = route["sourceMessageId"] as? String, UUID(uuidString: source) != nil,
                      let sender = route["senderUserId"] as? String, UUID(uuidString: sender) != nil else {
                    throw Self.failure("delivery_missing", "A final chat answer requires its original source and recipient")
                }
                self.invoke(context: context, name: "message_send", args: ["chat_id": chat, "text": text,
                    "to_user_ids": ["user:\(sender)"], "reply_to_message_id": "msg:\(source)",
                    "whisper": route["whisper"] as? Bool == true], authorize: authorize) { result in self.queue.async {
                        do {
                            let outbox = try self.store.snapshot()["outbox"] as? [String: [String: Any]] ?? [:]
                            let unknown = outbox.values.contains { row in
                                (row["context"] as? [String: Any])?["jobId"] as? String == context.jobId && row["status"] as? String == "pending"
                            }
                            if result["ok"] as? Bool != true, unknown {
                                throw Self.failure("delivery_uncertain", "Original chat result has no known delivery receipt; verify it before continuing")
                            }
                            completion(result)
                        } catch { completion(Self.safe(error).envelope) }
                    } }
            } catch { completion(Self.safe(error).envelope) }
        }
    }

    func invoke(context: GuguHostContext, name: String, args: [String: Any], authorize: @escaping Authorize,
                completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            let done: (Result<Any, Error>) -> Void = { result in self.queue.async {
                do {
                    let data = try result.get(); try self.check(); try authorize()
                    self.verifySources(context, authorize) { verified in self.queue.async {
                        do { _ = try verified.get(); try self.check(); try authorize(); completion(["ok": true, "data": data]) }
                        catch { completion(Self.safe(error).envelope) }
                    } }
                } catch { completion(Self.safe(error).envelope) }
            } }
            do {
                try self.validate(context); try authorize(); try GuguIOSCloudBroker.rejectCredentials(args)
                self.verifySources(context, authorize) { result in self.queue.async {
                    do {
                        _ = try result.get(); try authorize()
                        if name == "profile_whoami" {
                            self.perform(.activeAgent(context.agentUserId), authorize) { response in done(response.flatMap { raw in Result {
                                let identity = try Self.row(raw)
                                guard identity["owner_user_id"] as? String == context.ownerId, identity["device_id"] as? String == self.store.binding.deviceId else { throw Self.failure("not_granted", "Agent identity moved from this phone") }
                                return ["user_id": "user:\(context.agentUserId)", "session_id": "session:\(context.sessionId)", "display_name": identity["display_name"] ?? NSNull(), "gugu_number": identity["gugu_number"] ?? NSNull(), "device_id": "device:\(self.store.binding.deviceId)", "owner_user_id": "user:\(context.ownerId)"]
                            } }) }; return
                        }
                        if name == "message_conversations" {
                            guard args.isEmpty else { throw Self.failure("unsupported", "Native chat listing currently accepts no filters") }
                            self.perform(.chatList(agentId: context.agentUserId), authorize) { response in self.queue.async {
                                do {
                                    guard let rows = try response.get() as? [[String: Any]] else { throw Self.failure("cloud_protocol_error", "Agent chat listing is not an array") }
                                    for row in rows { if let chat = row["chat_id"] as? String { try self.usedChat(context, chat) } }
                                    done(.success(rows))
                                } catch { done(.failure(error)) }
                            } }; return
                        }
                        guard ["message_send", "message_rules", "message_members", "message_history"].contains(name), let address = args["chat_id"] as? String else { throw Self.failure("unknown_method", "Native communication method is unavailable") }
                        self.resolveChat(address, authorize) { response in self.queue.async {
                            do {
                                let chat = try response.get()
                                if name == "message_send" { try self.send(context, chat, args, authorize, done); return }
                                self.member(chat, context.agentUserId, authorize) { membership in self.queue.async {
                                    do {
                                        _ = try membership.get()
                                        if name == "message_rules" {
                                            self.rules(chat, context.agentUserId, authorize) { response in self.queue.async {
                                                do { let text = try response.get(); try self.usedChat(context, chat); try self.saveRules(context, chat, text); done(.success(["chat_id": chat, "rules": text])) }
                                                catch { done(.failure(error)) }
                                            } }; return
                                        }
                                        try self.usedChat(context, chat)
                                        if name == "message_members" { self.perform(.chatMembers(chatId: chat, agentId: context.agentUserId), authorize) { done($0.map { Self.typed($0) }) }; return }
                                        let limit = args["limit"] as? Int ?? 20
                                        guard (1...100).contains(limit), args["limit"] == nil || args["limit"] is Int else { throw Self.failure("invalid_args", "History limit is invalid") }
                                        if let raw = args["before_seq"], !(raw is Int) { throw Self.failure("invalid_args", "History sequence must be an integer") }
                                        let thread = try (args["thread_root_id"] as? String).map { try Self.uuid($0, prefix: "msg:") }
                                        self.perform(.chatHistory(chatId: chat, agentId: context.agentUserId, before: args["before_seq"] as? Int, limit: limit, thread: thread), authorize) { done($0.map { Self.typed($0, messages: true) }) }
                                    } catch { done(.failure(error)) }
                                } }
                            } catch { done(.failure(error)) }
                        } }
                    } catch { done(.failure(error)) }
                } }
            } catch { done(.failure(error)) }
        }
    }
    private func send(_ context: GuguHostContext, _ chat: String, _ args: [String: Any], _ authorize: @escaping Authorize, _ done: @escaping (Result<Any, Error>) -> Void) throws {
        guard let raw = args["text"] as? String, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw Self.failure("invalid_args", "Message text is required") }
        let content = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw = args["to_user_ids"], !(raw is [String]) { throw Self.failure("invalid_args", "Recipients must be typed addresses") }
        resolveRecipients(args["to_user_ids"] as? [String], authorize) { response in self.queue.async {
            do {
                let recipients = try response.get(), reply = try (args["reply_to_message_id"] as? String).map { try Self.uuid($0, prefix: "msg:") }
                if let value = args["whisper"] { guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw Self.failure("invalid_args", "Whisper must be a boolean") } }
                let whisper = args["whisper"] as? Bool == true
                guard !whisper || recipients?.count == 1 else { throw Self.failure("invalid_args", "Whisper requires exactly one recipient") }
                self.perform(.chatFacts(chatId: chat, agentId: context.agentUserId), authorize) { response in self.queue.async {
                    do {
                        let facts = try Self.row(response.get())
                        if ["group", "topic"].contains(facts["kind"] as? String ?? ""), recipients?.isEmpty != false { throw Self.failure("invalid_args", "Group message requires explicit recipients") }
                        self.member(chat, context.agentUserId, authorize, recipients: recipients ?? []) { response in self.queue.async {
                            do {
                                _ = try response.get()
                                self.rules(chat, context.agentUserId, authorize) { response in self.queue.async {
                                    do {
                                        let rules = try response.get(); try self.requireRules(context, chat, rules); try authorize()
                                        guard let input = try self.store.record("inputs", id: context.jobId) else { throw Self.failure("stale_context", "Original task input is unavailable") }
                                        let route = input["route"] as? [String: Any]
                                        let thread = route?["chatId"] as? String == chat ? route?["threadRootId"] as? String : nil
                                        let id = try GuguIOSStableID.values(["phone-message", context.agentUserId, context.jobId, chat, content, recipients as Any? ?? NSNull(), args["reply_to_message_id"] as Any? ?? NSNull(), whisper])
                                        let body: [String: Any] = ["p_message_id": id, "p_chat_id": chat, "p_sender_user_id": context.agentUserId, "p_to_user_ids": recipients as Any? ?? NSNull(), "p_content": content, "p_content_type": "text", "p_reply_to_message_id": reply as Any? ?? NSNull(), "p_thread_root_id": thread as Any? ?? NSNull(), "p_is_thread_root": false, "p_is_whisper": whisper]
                                        let fingerprint = try GuguHostJournal.digest(body)
                                        let saved = try self.store.admit("outbox", id: id, fingerprint: fingerprint) { ["status": "pending", "context": try GuguHostJournal.object(context), "body": body] }
                                        if saved["status"] as? String == "revoked" { throw Self.failure("not_granted", "Original message source authorization was revoked") }
                                        if let receipt = saved["receipt"] as? [String: Any] { done(.success(receipt)); return }
                                        self.verifySources(context, authorize) { response in self.queue.async {
                                            do {
                                                _ = try response.get(); try authorize()
                                                // Preserve a known write receipt in its original
                                                // custody before the outer post-write data guard.
                                                self.broker.perform(.sendMessage(body), binding: self.store.binding) { response in self.queue.async {
                                                    do {
                                                        let row = try Self.row(response.get())
                                                        guard row["id"] as? String == id else { throw Self.failure("cloud_protocol_error", "Message receipt differs from original stable ID") }
                                                        let receipt: [String: Any] = ["ok": true, "message_id": "msg:\(id)", "chat_id": chat, "message": ["id": id]]
                                                        try self.store.update("outbox", id: id) { $0["status"] = "sent"; $0["receipt"] = receipt }; done(.success(receipt))
                                                    } catch { done(.failure(error)) }
                                                } }
                                            } catch {
                                                if ["not_granted", "os_permission"].contains(Self.safe(error).code) { try? self.store.update("outbox", id: id) { $0["status"] = "revoked" } }
                                                done(.failure(error))
                                            }
                                        } }
                                    } catch { done(.failure(error)) }
                                } }
                            } catch { done(.failure(error)) }
                        } }
                    } catch { done(.failure(error)) }
                } }
            } catch { done(.failure(error)) }
        } }
    }
    private func validate(_ context: GuguHostContext) throws {
        try check()
        guard context.ownerId == store.binding.ownerId, context.installationId == store.binding.installationId,
              let input = try store.record("inputs", id: context.jobId), input["agentId"] as? String == context.agentUserId,
              input["sessionId"] as? String == context.sessionId, input["contextEpoch"] as? String == context.contextEpoch else { throw Self.failure("stale_context", "Communication context differs from native admitted input") }
    }
    private func verifySources(_ context: GuguHostContext, _ authorize: @escaping Authorize, _ done: @escaping (Result<Void, Error>) -> Void) {
        do {
            try validate(context); try authorize()
            sources.authorize(context) { response in self.queue.async {
                do { _ = try response.get(); try authorize(); done(.success(())) }
                catch { done(.failure(error)) }
            } }
        } catch { done(.failure(error)) }
    }
    private func usedChat(_ context: GuguHostContext, _ chat: String) throws {
        try sources.includeChat(chat, context: context)
    }
    private func member(_ chat: String, _ agent: String, _ authorize: @escaping Authorize, recipients: [String] = [], _ done: @escaping (Result<Void, Error>) -> Void) {
        perform(.chatMembers(chatId: chat, agentId: agent), authorize) { response in done(response.flatMap { raw in Result {
            guard let members = raw as? [[String: Any]], members.contains(where: { $0["user_id"] as? String == agent }), recipients.allSatisfy({ id in members.contains { $0["user_id"] as? String == id } }) else { throw Self.failure("not_granted", "Agent or recipient is no longer a member of this chat") }
        } }) }
    }
    private func rules(_ chat: String, _ agent: String, _ authorize: @escaping Authorize, _ done: @escaping (Result<String, Error>) -> Void) {
        perform(.chatFacts(chatId: chat, agentId: agent), authorize) { response in self.queue.async {
            do {
                let facts = try Self.row(response.get()), own = facts["group_prompt"] as? String ?? ""
                if !own.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { done(.success(own)); return }
                if facts["kind"] as? String == "topic", let source = facts["source_chat_id"] as? String {
                    self.perform(.chatFacts(chatId: source, agentId: agent), authorize) { response in done(response.flatMap { raw in Result { try Self.row(raw)["group_prompt"] as? String ?? "" } }) }; return
                }; done(.success(""))
            } catch { done(.failure(error)) }
        } }
    }
    private func saveRules(_ context: GuguHostContext, _ chat: String, _ text: String) throws {
        let key = "rules:\(context.agentUserId):\(chat):\(context.contextEpoch)"
        try store.transaction { state in var rows = state["requests"] as? [String: [String: Any]] ?? [:]; rows[key] = ["version": Self.version(text), "contextEpoch": context.contextEpoch]; state["requests"] = rows }
    }
    private func requireRules(_ context: GuguHostContext, _ chat: String, _ text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard try store.record("requests", id: "rules:\(context.agentUserId):\(chat):\(context.contextEpoch)")?["version"] as? String == Self.version(text) else { throw Self.failure("not_granted", "Read current message_rules before sending") }
    }
    private func resolveChat(_ raw: String, _ authorize: @escaping Authorize, _ done: @escaping (Result<String, Error>) -> Void) {
        if UUID(uuidString: raw) != nil { done(.success(raw)); return }
        perform(.resolveChat(raw), authorize) { response in done(response.flatMap { raw in Result { try Self.uuid(Self.row(raw)["id"] as? String ?? "") } }) }
    }
    private func resolveRecipients(_ raw: [String]?, _ authorize: @escaping Authorize, _ done: @escaping (Result<[String]?, Error>) -> Void) {
        guard let raw else { done(.success(nil)); return }; var values: [String] = []
        func next(_ index: Int) {
            guard index < raw.count else { done(.success(values)); return }
            do {
                let address = raw[index]
                if address.hasPrefix("user:") { values.append(try Self.uuid(address, prefix: "user:")); next(index + 1); return }
                if address.hasPrefix("session:") {
                    let session = try Self.uuid(address, prefix: "session:"), rows = try store.snapshot()["agents"] as? [String: [String: Any]] ?? [:]
                    guard let agent = rows.values.first(where: { $0["sessionId"] as? String == session })?["agentUserId"] as? String else { throw Self.failure("not_granted", "Session recipient is not on this phone") }
                    values.append(agent); next(index + 1); return
                }
                guard address.hasPrefix("gugu:") else { throw Self.failure("invalid_args", "Recipient requires a typed address") }
                perform(.resolveUser(String(address.dropFirst(5))), authorize) { response in self.queue.async {
                    do { values.append(try Self.uuid(Self.row(response.get())["id"] as? String ?? "")); next(index + 1) } catch { done(.failure(error)) }
                } }
            } catch { done(.failure(error)) }
        }; next(0)
    }
    private func perform(_ operation: GuguIOSCloudOperation, _ authorize: @escaping Authorize, _ done: @escaping (Result<Any, Error>) -> Void) {
        do { try check(); try authorize() } catch { done(.failure(error)); return }
        broker.perform(operation, binding: store.binding) { response in self.queue.async {
            do { try self.check(); try authorize(); done(.success(try response.get())) } catch { done(.failure(error)) }
        } }
    }
    private static func row(_ raw: Any) throws -> [String: Any] {
        guard let row = (raw as? [[String: Any]])?.first ?? raw as? [String: Any] else { throw failure("cloud_protocol_error", "Cloud operation returned no row") }; return row
    }
    private static func typed(_ raw: Any, messages: Bool = false) -> Any {
        if let rows = raw as? [Any] { return rows.map { typed($0, messages: messages) } }
        guard let row = raw as? [String: Any] else { return raw }
        var value: [String: Any] = [:]
        for (key, item) in row {
            if let id = item as? String, !id.contains(":"), ["user_id", "sender_user_id", "owner_user_id", "creator_user_id", "agent_user_id", "reply_to_sender_user_id"].contains(key) { value[key] = "user:\(id)" }
            else if let id = item as? String, !id.contains(":"), ["message_id", "reply_to_message_id", "thread_root_id", "source_message_id"].contains(key) || (messages && key == "id") { value[key] = "msg:\(id)" }
            else if key == "to_user_ids", let ids = item as? [String] { value[key] = ids.map { $0.contains(":") ? $0 : "user:\($0)" } }
            else { value[key] = typed(item) }
        }; return value
    }
    private static func uuid(_ raw: String, prefix: String = "") throws -> String {
        let value = !prefix.isEmpty && raw.hasPrefix(prefix) ? String(raw.dropFirst(prefix.count)) : raw
        guard UUID(uuidString: value) != nil else { throw failure("invalid_args", "Expected a registered UUID address") }; return value
    }
    private static func version(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "none" : String(SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16)) }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { .init(code: code, message: text) }
    private static func safe(_ error: Error) -> GuguHostFailure { error as? GuguHostFailure ?? failure("message_failed", "Native communication failed") }
}
