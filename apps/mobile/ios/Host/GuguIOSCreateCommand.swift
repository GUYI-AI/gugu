import Foundation

/// Existing agent.create command custody. Native session IDs are generated only
/// inside durable first admission; retry/reconciliation reuses the same record.
final class GuguIOSCreateCommand {
    typealias Start = ([String: Any], @escaping (Result<Void, Error>) -> Void) -> Void
    private let queue = DispatchQueue(label: "app.gugu.ios.create-command")
    private let broker: GuguIOSCloudBroker
    private let store: GuguIOSBackendStore
    private let instanceId: String
    private let projectPath: String
    private let check: () throws -> Void
    private let start: Start
    private var inFlight: Set<String> = []

    init(broker: GuguIOSCloudBroker, store: GuguIOSBackendStore, instanceId: String, projectPath: String,
         check: @escaping () throws -> Void, start: @escaping Start) {
        self.broker = broker; self.store = store; self.instanceId = instanceId; self.projectPath = projectPath
        self.check = check; self.start = start
    }
    func execute(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            do {
                try self.check()
                guard UUID(uuidString: id) != nil, UUID(uuidString: self.instanceId) != nil else { throw Self.failure("invalid_args", "Command and runtime IDs must be UUIDs") }
                guard !self.inFlight.contains(id) else { throw Self.failure("admission_uncertain", "Original create command is still in progress") }
                let saved = try self.store.admit("requests", id: "command:\(id)", fingerprint: id) {
                    ["kind": "create-command", "claimToken": UUID().uuidString.lowercased(), "instanceId": self.instanceId, "status": "pending"]
                }
                guard let token = saved["claimToken"] as? String else { throw Self.failure("invalid_journal", "Original command claim is missing") }
                self.inFlight.insert(id)
                let finish: (Result<Void, Error>) -> Void = { result in self.queue.async { self.inFlight.remove(id); completion(result) } }
                let done: (Result<Void, Error>) -> Void = { result in
                    if case .failure(let error as GuguHostFailure) = result,
                       ["invalid_args", "unsupported", "not_granted", "model_unavailable"].contains(error.code) {
                        self.perform(.failCommand(id: id, claimToken: token, message: error.message, at: Self.now())) { settled in
                            if let raw = try? settled.get(), let rows = raw as? [[String: Any]], rows.count == 1 {
                                try? self.store.update("requests", id: "command:\(id)") { $0["status"] = "failed" }
                            }
                            finish(result)
                        }
                    } else { finish(result) }
                }
                self.perform(.readCommand(id)) { result in
                    do { self.advance(id, token, try self.command(result.get(), id), done) }
                    catch { done(.failure(error)) }
                }
            } catch { completion(.failure(error)) }
        }
    }
    private func advance(_ id: String, _ token: String, _ command: [String: Any], _ done: @escaping (Result<Void, Error>) -> Void) {
        switch command["status"] as? String {
        case "pending":
            perform(.claimCommand(id: id, claimToken: token, instanceId: instanceId, at: Self.now())) { result in
                do { _ = try result.get() }
                catch { done(.failure(error)); return }
                self.perform(.readCommand(id)) { result in
                    do { self.claimed(id, token, try self.command(result.get(), id), done) }
                    catch { done(.failure(error)) }
                }
            }
        case "running": claimed(id, token, command, done)
        case "done":
            do {
                guard let payload = command["payload"] as? [String: Any], let agentId = payload["agent_user_id"] as? String,
                      let agent = try store.record("agents", id: agentId), agent["createCommandId"] as? String == id else {
                    throw Self.failure("record_unreadable", "Completed cloud command has no original native session custody")
                }
                start(agent) { result in self.queue.async {
                    do {
                        _ = try result.get(); try self.check()
                        try self.store.update("requests", id: "command:\(id)") { $0["status"] = "completed" }
                        done(.success(()))
                    } catch { done(.failure(error)) }
                } }
            } catch { done(.failure(error)) }
        default: done(.failure(Self.failure("create_command_unavailable", "Create command is not claimable or completed")))
        }
    }
    private func claimed(_ id: String, _ token: String, _ command: [String: Any], _ done: @escaping (Result<Void, Error>) -> Void) {
        guard command["status"] as? String == "running", command["claim_token"] as? String == token,
              command["claimed_by"] as? String == instanceId else { done(.failure(Self.failure("admission_uncertain", "Create command is owned by another claim or runtime"))); return }
        perform(.recheckCommand(id: id, claimToken: token)) { result in
            do {
                guard try result.get() as? Bool == true else { throw Self.failure("stale_context", "Cloud command lease no longer authorizes execution") }
                guard let payload = command["payload"] as? [String: Any], let agentId = payload["agent_user_id"] as? String,
                      UUID(uuidString: agentId) != nil, payload["agent_type"] as? String == "pi",
                      let chat = payload["greeting_chat_id"] as? String, UUID(uuidString: chat) != nil,
                      let name = payload["display_name"] as? String, !name.isEmpty,
                      payload["effort"] == nil || payload["effort"] is NSNull,
                      payload["permission_mode"] == nil || payload["permission_mode"] is NSNull,
                      Self.acceptsProjectPath(payload["project_path"], nativeRoot: self.projectPath) else {
                    throw Self.failure("unsupported", "Create command has unsupported phone runtime parameters")
                }
                // A routed initial message requires the shared delivery envelope,
                // not raw text. The concrete task backend must supply that path.
                guard !(payload["initial_prompt"] is String), !(payload["first_task"] is String) else {
                    throw Self.failure("unsupported", "Routed startup input requires the native inbox delivery adapter")
                }
                self.perform(.activeAgent(agentId)) { result in
                    do {
                        guard let identity = Self.first(try result.get()), identity["id"] as? String == agentId,
                              identity["type"] as? String == "agent", identity["owner_user_id"] as? String == self.store.binding.ownerId,
                              identity["device_id"] as? String == self.store.binding.deviceId else { throw Self.failure("not_granted", "Agent is not owned by this native phone") }
                        let model = payload["model"] as? String
                        guard let model, model.hasPrefix("platform:"), model.count > "platform:".count else { throw Self.failure("model_unavailable", "Create command requires an explicit platform model") }
                        self.prepareSession(id, token, agentId, chat, identity["display_name"] as? String ?? name, model, done)
                    } catch { done(.failure(error)) }
                }
            } catch { done(.failure(error)) }
        }
    }
    private func prepareSession(_ id: String, _ token: String, _ agentId: String, _ chat: String, _ name: String,
                                _ model: String, _ done: @escaping (Result<Void, Error>) -> Void) {
        broker.catalog(binding: store.binding, includeHidden: true) { result in self.queue.async {
            do {
                try self.check()
                let modelId = String(model.dropFirst("platform:".count))
                guard try result.get().contains(where: { $0["id"] as? String == modelId }) else { throw Self.failure("model_unavailable", "Create command selected an unavailable platform model") }
                let fingerprint = try GuguHostJournal.digest(["agentId": agentId, "chatId": chat, "modelId": model, "commandId": id])
                let agent = try self.store.admit("agents", id: agentId, fingerprint: fingerprint) {
                    ["ownerId": self.store.binding.ownerId, "deviceId": self.store.binding.deviceId, "agentUserId": agentId,
                     "sessionId": UUID().uuidString.lowercased(), "contextEpoch": UUID().uuidString.lowercased(), "createCommandId": id,
                     "chatId": chat, "displayName": name, "modelId": modelId, "status": "idle"]
                }
                self.start(agent) { result in self.queue.async {
                    do { _ = try result.get(); try self.check() }
                    catch { done(.failure(error)); return }
                    self.reportAndSettle(id, token, agent, done)
                } }
            } catch { done(.failure(error)) }
        } }
    }
    private func reportAndSettle(_ id: String, _ token: String, _ agent: [String: Any], _ done: @escaping (Result<Void, Error>) -> Void) {
        let report: [String: Any] = ["p_agent_user_id": agent["agentUserId"]!, "p_activity_status": "idle", "p_runtime_kind": "gugu", "p_runtime_label": "iOS",
            "p_last_seen_at": Self.now(), "p_recent_actions": NSNull(), "p_last_action_at": NSNull(), "p_agent_status": "idle", "p_agent_status_detail": "plain"]
        perform(.runtimeState(report)) { result in
            do { _ = try result.get() } catch { done(.failure(error)); return }
            self.perform(.recheckCommand(id: id, claimToken: token)) { result in
                do { guard try result.get() as? Bool == true else { throw Self.failure("stale_context", "Command lease changed before settlement") } }
                catch { done(.failure(error)); return }
                let receipt: [String: Any] = ["gugu_user_id": agent["agentUserId"]!, "chat_id": agent["chatId"]!, "agent_type": "pi", "project_path": self.projectPath, "created": true]
                self.perform(.completeCommand(id: id, claimToken: token, result: receipt, at: Self.now())) { result in
                    do {
                        guard let rows = try result.get() as? [[String: Any]], rows.count == 1, rows[0]["id"] as? String == id else {
                            throw Self.failure("admission_uncertain", "Cloud command did not confirm original claim settlement")
                        }
                        try self.store.update("requests", id: "command:\(id)") { $0["status"] = "completed"; $0["result"] = receipt }
                        done(.success(()))
                    } catch { done(.failure(error)) }
                }
            }
        }
    }
    private func perform(_ operation: GuguIOSCloudOperation, _ completion: @escaping (Result<Any, Error>) -> Void) {
        do { try check() } catch { completion(.failure(error)); return }
        broker.perform(operation, binding: store.binding) { result in self.queue.async {
            do { try self.check(); completion(.success(try result.get())) } catch { completion(.failure(error)) }
        } }
    }
    private func command(_ raw: Any, _ id: String) throws -> [String: Any] {
        guard let row = Self.first(raw), row["id"] as? String == id, row["device_id"] as? String == store.binding.deviceId,
              row["type"] as? String == "agent.create" else { throw Self.failure("stale_context", "Cloud create command targets another device or identity") }
        return row
    }
    private static func first(_ value: Any) -> [String: Any]? { (value as? [[String: Any]])?.first ?? value as? [String: Any] }
    private static func acceptsProjectPath(_ value: Any?, nativeRoot: String) -> Bool {
        guard let value, !(value is NSNull) else { return true }
        guard let text = value as? String else { return false }
        // shared deviceCommandRuntime.text + Android startAgentSession: an
        // omitted/blank path means the phone's private root, never an OS path.
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty || normalized == nativeRoot
    }
    private static func now() -> String { ISO8601DateFormatter().string(from: Date()) }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { GuguHostFailure(code: code, message: text) }
}
