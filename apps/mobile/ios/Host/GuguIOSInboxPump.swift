import Foundation
import CryptoKit

/// The cloud owns unread facts. This reader keeps only one in-memory scan per
/// recipient; execution custody and rule receipts are committed by the scheduler
/// before an exact original-source read ACK can be dispatched.
final class GuguIOSInboxPump {
    private final class Flight {
        var again = false
        var admitted = 0
        var callbacks: [(Result<Int, Error>) -> Void] = []
    }
    private let queue = DispatchQueue(label: "app.gugu.ios.inbox-pump")
    private let store: GuguIOSBackendStore
    private let broker: GuguIOSCloudBroker
    private let sources: GuguIOSSourceAccess
    private let runtime: GuguJavaScriptRuntime
    private let scheduler: GuguIOSTaskScheduler
    private let check: () throws -> Void
    private var flights: [String: Flight] = [:]

    init(store: GuguIOSBackendStore, broker: GuguIOSCloudBroker, sources: GuguIOSSourceAccess,
         runtime: GuguJavaScriptRuntime, scheduler: GuguIOSTaskScheduler, check: @escaping () throws -> Void) {
        self.store = store; self.broker = broker; self.sources = sources; self.runtime = runtime
        self.scheduler = scheduler; self.check = check
    }

    func pull(agentId: String, completion: @escaping (Result<Int, Error>) -> Void) {
        queue.async {
            if let flight = self.flights[agentId] { flight.again = true; flight.callbacks.append(completion); return }
            let flight = Flight(); flight.callbacks = [completion]; self.flights[agentId] = flight
            self.page(agentId, flight, after: nil, fence: nil)
        }
    }
    private func finish(_ agentId: String, _ flight: Flight, _ error: Error? = nil) {
        guard flights[agentId] === flight else { return }
        if error == nil, flight.again {
            flight.again = false; page(agentId, flight, after: nil, fence: nil); return
        }
        flights.removeValue(forKey: agentId)
        let result: Result<Int, Error> = error.map { .failure($0) } ?? .success(flight.admitted)
        for done in flight.callbacks { done(result) }
    }
    private func agent(_ id: String) throws -> [String: Any] {
        try check()
        guard UUID(uuidString: id) != nil, let row = try store.record("agents", id: id),
              row["agentUserId"] as? String == id, row["ownerId"] as? String == store.binding.ownerId,
              row["deviceId"] as? String == store.binding.deviceId,
              let session = row["sessionId"] as? String, UUID(uuidString: session) != nil,
              let epoch = row["contextEpoch"] as? String, UUID(uuidString: epoch) != nil,
              row["status"] as? String != "archived" else {
            throw Self.failure("stale_context", "Inbox recipient has no current native session")
        }
        return row
    }
    private func page(_ agentId: String, _ flight: Flight, after: [String: Any]?, fence: Int?) {
        do {
            _ = try agent(agentId)
            broker.perform(.inbox(agentId: agentId, chatId: nil, afterSeq: nil, scanAfter: after, scanFence: fence), binding: store.binding) { response in self.queue.async {
                do {
                    try self.check(); _ = try self.agent(agentId)
                    guard let rows = try response.get() as? [[String: Any]] else { throw Self.failure("cloud_protocol_error", "Native inbox response is not an array") }
                    func next(_ index: Int) {
                        guard index < rows.count else {
                            do {
                                guard rows.count >= 80, let tail = rows.last else { self.finish(agentId, flight); return }
                                guard let chat = tail["chat_id"] as? String, UUID(uuidString: chat) != nil,
                                      let seq = tail["seq"] as? Int, seq > 0,
                                      let serverFence = tail["scan_max_ingest_seq"] as? Int, serverFence >= 0,
                                      fence == nil || fence == serverFence else {
                                    throw Self.failure("cloud_protocol_error", "Native inbox page has no matching finite server fence")
                                }
                                if let after, let previousChat = after["chat_id"] as? String, let previousSeq = after["seq"] as? Int {
                                    guard chat > previousChat || chat == previousChat && seq > previousSeq else { throw Self.failure("cloud_protocol_error", "Native inbox scan cursor did not advance") }
                                }
                                self.page(agentId, flight, after: ["chat_id": chat, "seq": seq], fence: fence ?? serverFence)
                            } catch { self.finish(agentId, flight, error) }
                            return
                        }
                        self.admit(rows[index], agentId: agentId) { result in self.queue.async {
                            do { _ = try result.get(); flight.admitted += 1; next(index + 1) }
                            catch { self.finish(agentId, flight, error) }
                        } }
                    }
                    next(0)
                } catch { self.finish(agentId, flight, error) }
            } }
        } catch { finish(agentId, flight, error) }
    }
    private func admit(_ row: [String: Any], agentId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            let agent = try self.agent(agentId)
            guard let chat = row["chat_id"] as? String, UUID(uuidString: chat) != nil,
                  let source = row["id"] as? String, UUID(uuidString: source) != nil,
                  let epoch = agent["contextEpoch"] as? String, let session = agent["sessionId"] as? String else {
                throw Self.failure("cloud_protocol_error", "Native inbox source identity is incomplete")
            }
            sources.authorizeSession(agentId: agentId, sessionId: session, contextEpoch: epoch, extraChats: [chat]) { allowed in self.queue.async {
                do {
                    _ = try allowed.get(); try self.require(agent, id: agentId)
                    var projection: [String: Any] = ["ownerId": self.store.binding.ownerId, "agentUserId": agentId, "row": row]
                    if ["group", "topic"].contains(row["chat_kind"] as? String ?? "") {
                        guard let raw = row["group_rules"], raw is NSNull || raw is String else {
                            throw Self.failure("cloud_protocol_error", "Native inbox has no authoritative rules")
                        }
                        let text = raw as? String ?? "", version = Self.version(text)
                        let delivered = try self.store.record("requests", id: "rules:\(agentId):\(chat):\(epoch)")?["version"] as? String
                        projection["groupRules"] = ["version": version, "text": delivered == version ? NSNull() : text as Any]
                    }
                    let project: ([String: Any]) -> Void = { projection in
                        do {
                            try self.runtime.readDelivery(projection) { response in self.queue.async {
                                do {
                                    try self.require(agent, id: agentId)
                                    guard response["ok"] as? Bool == true else {
                                        throw Self.failure(response["code"] as? String ?? "delivery_invalid", response["message"] as? String ?? "Native delivery projection failed")
                                    }
                                    let delivery = try GuguIOSInboxDelivery(row: row, projection: response)
                                    let jobId = try self.store.inboxJobID(agentId: agentId, sourceMessageId: source)
                                    self.scheduler.admit(agent: agent, text: delivery.prompt, id: jobId, delivery: delivery) { result in self.queue.async {
                                        do {
                                            _ = try result.get(); try self.require(agent, id: agentId)
                                            // Source access is rechecked after persistence. A failed/lost
                                            // ACK re-pulls the same recipient/source job, never executes it again.
                                            self.sources.authorizeSession(agentId: agentId, sessionId: session, contextEpoch: epoch, extraChats: [chat]) { checked in self.queue.async {
                                                do {
                                                    _ = try checked.get(); try self.require(agent, id: agentId)
                                                    self.broker.perform(.markRead(agentId: agentId, chatId: chat, messageId: source), binding: self.store.binding) { ack in self.queue.async {
                                                        do { _ = try ack.get(); try self.require(agent, id: agentId); completion(.success(())) }
                                                        catch { completion(.failure(error)) }
                                                    } }
                                                } catch { completion(.failure(error)) }
                                            } }
                                        } catch { completion(.failure(error)) }
                                    } }
                                } catch { completion(.failure(error)) }
                            } }
                        } catch { completion(.failure(error)) }
                    }
                    let thread = row["thread_root_id"] as? String ?? (row["is_thread_root"] as? Bool == true ? source : nil)
                    if let thread, let seq = row["seq"] as? Int {
                        self.broker.perform(.chatHistory(chatId: chat, agentId: agentId, before: seq, limit: 20, thread: thread), binding: self.store.binding) { response in self.queue.async {
                            do {
                                try self.require(agent, id: agentId)
                                guard let messages = try response.get() as? [[String: Any]] else { throw Self.failure("cloud_protocol_error", "Native thread history is not an array") }
                                projection["threadMessages"] = Array(messages.reversed()); project(projection)
                            } catch { completion(.failure(error)) }
                        } }
                    } else { project(projection) }
                } catch { completion(.failure(error)) }
            } }
        } catch { completion(.failure(error)) }
    }
    private func require(_ original: [String: Any], id: String) throws {
        let latest = try agent(id)
        guard latest["sessionId"] as? String == original["sessionId"] as? String,
              latest["contextEpoch"] as? String == original["contextEpoch"] as? String else {
            throw Self.failure("stale_context", "Native inbox session changed during delivery")
        }
    }
    private static func version(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "none" : String(SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16))
    }
    private static func failure(_ code: String, _ message: String) -> GuguHostFailure { .init(code: code, message: message) }
}
