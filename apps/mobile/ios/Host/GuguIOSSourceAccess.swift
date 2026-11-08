import Foundation

/// Native source lineage for one registry context. Model dispatch, continued
/// turns and timeline delivery must recheck every chat contributing to it.
/// An owner JWT never substitutes for the Agent-as membership checks.
final class GuguIOSSourceAccess {
    private let queue = DispatchQueue(label: "app.gugu.ios.source-access")
    private let store: GuguIOSBackendStore
    private let broker: GuguIOSCloudBroker
    private let check: () throws -> Void
    init(store: GuguIOSBackendStore, broker: GuguIOSCloudBroker, check: @escaping () throws -> Void) { self.store = store; self.broker = broker; self.check = check }

    func authorize(_ context: GuguHostContext, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            do {
                try self.check()
                guard context.ownerId == self.store.binding.ownerId, context.installationId == self.store.binding.installationId,
                      let input = try self.store.record("inputs", id: context.jobId), input["agentId"] as? String == context.agentUserId,
                      input["sessionId"] as? String == context.sessionId, input["contextEpoch"] as? String == context.contextEpoch else { throw Self.failure("stale_context", "Source check has no matching native input") }
                self.authorizeSession(agentId: context.agentUserId, sessionId: context.sessionId, contextEpoch: context.contextEpoch,
                    extraChats: try Self.chats(input), completion: completion)
            } catch { completion(.failure(error)) }
        }
    }
    func authorizeSession(agentId: String, sessionId: String, contextEpoch: String, extraChats: [String] = [], completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            do {
                try self.check()
                let agent = try self.agent(agentId, sessionId, contextEpoch)
                guard extraChats.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw Self.failure("invalid_journal", "Task source chat identity is invalid") }
                let chats = Array(Set(try Self.chats(agent) + extraChats)).sorted()
                self.perform(.activeAgent(agentId)) { result in self.queue.async {
                    do {
                        guard let rows = try result.get() as? [[String: Any]], rows.count == 1,
                              rows[0]["id"] as? String == agentId, rows[0]["type"] as? String == "agent",
                              rows[0]["owner_user_id"] as? String == self.store.binding.ownerId, rows[0]["device_id"] as? String == self.store.binding.deviceId else { throw Self.failure("not_granted", "Source Agent no longer belongs to this phone") }
                        func next(_ index: Int) {
                            guard index < chats.count else {
                                do {
                                    try self.check()
                                    let latest = try self.agent(agentId, sessionId, contextEpoch)
                                    guard Set(try Self.chats(latest) + extraChats) == Set(chats) else { throw Self.failure("stale_context", "Task source lineage changed during authorization") }
                                    completion(.success(()))
                                }
                                catch { completion(.failure(error)) }; return
                            }
                            self.perform(.chatMembers(chatId: chats[index], agentId: agentId)) { result in self.queue.async {
                                do {
                                    guard let members = try result.get() as? [[String: Any]], members.contains(where: { $0["user_id"] as? String == agentId }) else { throw Self.failure("not_granted", "Task source chat membership was revoked") }
                                    next(index + 1)
                                } catch { completion(.failure(error)) }
                            } }
                        }; next(0)
                    } catch { completion(.failure(error)) }
                } }
            } catch { completion(.failure(error)) }
        }
    }
    /// Call before returning chat data to Pi. One atomic record covers both the
    /// active input and all later turns continuing this same registry context.
    func includeChat(_ chat: String, context: GuguHostContext) throws {
        try check()
        guard UUID(uuidString: chat) != nil else { throw Self.failure("invalid_args", "Source chat must be a UUID") }
        guard context.ownerId == store.binding.ownerId, context.installationId == store.binding.installationId else { throw Self.failure("stale_context", "Source lineage belongs to another native owner or installation") }
        try store.transaction { state in
            var inputs = state["inputs"] as? [String: [String: Any]] ?? [:], agents = state["agents"] as? [String: [String: Any]] ?? [:]
            guard var input = inputs[context.jobId], var agent = agents[context.agentUserId],
                  input["agentId"] as? String == context.agentUserId, input["sessionId"] as? String == context.sessionId,
                  input["contextEpoch"] as? String == context.contextEpoch, agent["sessionId"] as? String == context.sessionId,
                  agent["contextEpoch"] as? String == context.contextEpoch, agent["agentUserId"] as? String == context.agentUserId, agent["ownerId"] as? String == store.binding.ownerId,
                  agent["deviceId"] as? String == store.binding.deviceId else { throw Self.failure("stale_context", "Source lineage belongs to another registry context") }
            var inputChats = try Self.chats(input), contextChats = try Self.chats(agent)
            if !inputChats.contains(chat) { inputChats.append(chat) }; if !contextChats.contains(chat) { contextChats.append(chat) }
            input["usedChatIds"] = inputChats; agent["usedChatIds"] = contextChats
            inputs[context.jobId] = input; agents[context.agentUserId] = agent; state["inputs"] = inputs; state["agents"] = agents
        }
    }
    private func agent(_ id: String, _ session: String, _ epoch: String) throws -> [String: Any] {
        guard let row = try store.record("agents", id: id), row["agentUserId"] as? String == id, row["ownerId"] as? String == store.binding.ownerId, row["deviceId"] as? String == store.binding.deviceId,
              row["sessionId"] as? String == session, row["contextEpoch"] as? String == epoch else { throw Self.failure("stale_context", "Source registry context changed") }; return row
    }
    private func perform(_ operation: GuguIOSCloudOperation, completion: @escaping (Result<Any, Error>) -> Void) {
        do { try check() } catch { completion(.failure(error)); return }
        broker.perform(operation, binding: store.binding) { result in self.queue.async {
            do { try self.check(); completion(.success(try result.get())) } catch { completion(.failure(error)) }
        } }
    }
    private static func chats(_ row: [String: Any]) throws -> [String] {
        guard let raw = row["usedChatIds"] else { return [] }
        guard let chats = raw as? [String], chats.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw failure("invalid_journal", "Task source lineage is unreadable") }
        return chats
    }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { .init(code: code, message: text) }
}
