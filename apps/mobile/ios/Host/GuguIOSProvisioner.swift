import Foundation

/// Drives the existing Android provision saga. The executor must claim/settle
/// its real create command and persist the native session before returning.
/// There is no local identity-minting or success default for that dependency.
final class GuguIOSProvisioner {
    typealias CreateCommand = (String, @escaping (Result<Void, Error>) -> Void) -> Void
    typealias Admit = ([String: Any], String, String, @escaping (Result<Void, Error>) -> Void) -> Void
    private let queue = DispatchQueue(label: "app.gugu.ios.provision")
    private let store: GuguIOSBackendStore
    private let broker: GuguIOSCloudBroker
    private let check: () throws -> Void
    private let executeCreate: CreateCommand
    private let admit: Admit
    private let projectId: String
    private let projectPath: String
    private var inFlight: Set<String> = []

    init(store: GuguIOSBackendStore, broker: GuguIOSCloudBroker, projectPath: String, check: @escaping () throws -> Void,
         executeCreate: @escaping CreateCommand, admit: @escaping Admit) throws {
        self.store = store; self.broker = broker; self.projectPath = projectPath; self.check = check
        self.executeCreate = executeCreate; self.admit = admit
        projectId = try GuguIOSStableID.strings("phone-project", store.binding.ownerId, store.binding.deviceId)
    }

    func create(requestId: String, input: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        queue.async {
            do {
                try self.check(); try GuguIOSCloudBroker.rejectCredentials(input)
                guard UUID(uuidString: requestId) != nil else { throw Self.failure("invalid_args", "Original host request ID is required") }
                let client = input["clientRequestId"] as? String
                if let client, UUID(uuidString: client) == nil { throw Self.failure("invalid_args", "clientRequestId must be a UUID") }
                let key = client.map { "client:\($0)" } ?? requestId
                let validated = try self.validate(input)
                let fingerprint = try GuguHostJournal.digest(validated)
                let previous = try self.store.record("requests", id: key)
                if let saved = previous {
                    guard saved["fingerprint"] as? String == fingerprint else { throw Self.failure("duplicate_conflict", "Original creation request cannot change input") }
                    if let result = saved["result"] as? [String: Any] { completion(.success(result)); return }
                }
                guard !self.inFlight.contains(key) else { throw Self.failure("admission_uncertain", "Original creation request is still in progress") }
                self.inFlight.insert(key)
                let done: (Result<[String: Any], Error>) -> Void = { result in self.queue.async {
                    self.inFlight.remove(key); completion(result)
                } }
                if let saved = previous { self.start(key, saved, done); return }
                self.resolveModel(validated["model"] as? String) { result in
                    do {
                        let model = try result.get(); try self.check()
                        self.resolveGroup(validated["chatId"] as? String) { result in
                            do {
                                let group = try result.get(); try self.check()
                                let saved = try self.store.admit("requests", id: key, fingerprint: fingerprint) {
                                    ["kind": "spawn", "operationId": UUID().uuidString.lowercased(), "provisionId": UUID().uuidString.lowercased(),
                                     "displayName": validated["title"]!, "modelId": model, "prompt": validated["prompt"]!,
                                     "birthGroupChatId": group as Any? ?? NSNull(), "status": "pending"]
                                }
                                self.start(key, saved, done)
                            } catch { done(.failure(error)) }
                        }
                    } catch { done(.failure(error)) }
                }
            } catch { completion(.failure(error)) }
        }
    }

    private func start(_ key: String, _ saved: [String: Any], _ done: @escaping (Result<[String: Any], Error>) -> Void) {
        do {
            guard let operation = saved["operationId"] as? String, let provision = saved["provisionId"] as? String,
                  let name = saved["displayName"] as? String, let model = saved["modelId"] as? String, saved["prompt"] is String else { throw Self.failure("invalid_journal", "Provision intent is incomplete") }
            perform(.startProvision(operationId: operation, provisionId: provision, displayName: name, modelId: model)) { result in
                switch result {
                case .failure(let error): done(.failure(error))
                case .success:
                    self.perform(.readProvision(provision)) { result in
                        do { self.advance(key, saved, try self.row(result.get(), intent: saved), done) }
                        catch { done(.failure(error)) }
                    }
                }
            }
        } catch { done(.failure(error)) }
    }

    private func advance(_ key: String, _ saved: [String: Any], _ row: [String: Any], _ done: @escaping (Result<[String: Any], Error>) -> Void) {
        if row["provisioned_agent_user_id"] is String && !(row["agent_user_id"] is String) { done(.failure(Self.failure("identity_removed", "Provisioned Agent was removed; retry cannot mint another identity"))); return }
        let phase = row["phase"] as? String
        if phase == "queued" || phase == "failed" {
            perform(.claimProvision(operationId: saved["operationId"] as! String, retryProvisionId: phase == "failed" ? saved["provisionId"] as? String : nil)) { result in
                do {
                    _ = try result.get()
                    self.perform(.readProvision(saved["provisionId"] as! String)) { result in
                        do {
                            let claimed = try self.row(result.get(), intent: saved)
                            guard claimed["phase"] as? String == "preparing" else { throw Self.failure("admission_uncertain", "Same creation has not acquired a provision slot") }
                            self.prepare(key, saved, claimed, done)
                        } catch { done(.failure(error)) }
                    }
                } catch { done(.failure(error)) }
            }
        } else if phase == "preparing" { prepare(key, saved, row, done) }
        else { finishCommand(key, saved, row, done) }
    }

    private func prepare(_ key: String, _ saved: [String: Any], _ row: [String: Any], _ done: @escaping (Result<[String: Any], Error>) -> Void) {
        perform(.prepareProvision(row)) { result in
            do { self.finishCommand(key, saved, try self.row(result.get(), intent: saved), done) }
            catch { done(.failure(error)) }
        }
    }

    private func finishCommand(_ key: String, _ saved: [String: Any], _ row: [String: Any], _ done: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let command = row["create_command_id"] as? String, UUID(uuidString: command) != nil,
              let agentId = row["agent_user_id"] as? String, UUID(uuidString: agentId) != nil else { done(.failure(Self.failure("admission_uncertain", "Provision has not returned its Agent and create command"))); return }
        executeCreate(command) { result in self.queue.async {
            do { _ = try result.get(); try self.check() }
            catch { done(.failure(error)); return }
            self.perform(.readCommand(command)) { result in
                do {
                    guard let commandRow = Self.first(try result.get()), ["done", "error"].contains(commandRow["status"] as? String ?? "") else {
                        throw Self.failure("admission_uncertain", "Native create command has no terminal receipt")
                    }
                    self.perform(.settleProvision(saved["provisionId"] as! String)) { result in
                        do {
                            let settled = try self.row(result.get(), intent: saved)
                            guard settled["phase"] as? String != "failed", settled["agent_user_id"] as? String == agentId else { throw Self.failure("provision_failed", "Provision did not settle the original Agent identity") }
                            self.perform(.completeProvision(saved["provisionId"] as! String)) { result in
                                do { _ = try result.get(); try self.completeLocal(key, saved, agentId, done) }
                                catch { done(.failure(error)) }
                            }
                        } catch { done(.failure(error)) }
                    }
                } catch { done(.failure(error)) }
            }
        } }
    }

    private func completeLocal(_ key: String, _ saved: [String: Any], _ agentId: String, _ done: @escaping (Result<[String: Any], Error>) -> Void) throws {
        guard let agent = try store.record("agents", id: agentId), let sessionId = agent["sessionId"] as? String,
              let chatId = agent["chatId"] as? String else { throw Self.failure("invalid_journal", "Completed create command has no durable native session") }
        let complete: () -> Void = {
            do {
                let id = try GuguIOSStableID.strings(saved["operationId"] as! String, "initial-task")
                self.admit(agent, saved["prompt"] as! String, id) { result in self.queue.async {
                    do {
                        _ = try result.get(); try self.check()
                        guard let latest = try self.store.record("agents", id: agentId) else { throw Self.failure("invalid_journal", "Native session disappeared before admission receipt") }
                        let result: [String: Any] = ["conversationId": sessionId, "projectId": self.projectId, "title": latest["displayName"] ?? saved["displayName"]!,
                            "agentUserId": agentId, "chatId": chatId, "birthGroup": latest["birthGroup"] ?? NSNull(), "session": Self.summary(latest, projectId: self.projectId)]
                        try self.store.update("requests", id: key) { $0["result"] = result; $0["status"] = "completed" }
                        done(.success(result))
                    } catch { done(.failure(error)) }
                } }
            } catch { done(.failure(error)) }
        }
        if let group = saved["birthGroupChatId"] as? String, agent["birthGroup"] == nil {
            perform(.joinBirthGroup(chatId: group, agentId: agentId)) { result in
                do {
                    guard let row = Self.first(try result.get()), ["joined", "pending_approval"].contains(row["status"] as? String ?? "") else { throw Self.failure("birth_group_failed", "Birth group returned no membership result") }
                    try self.store.update("agents", id: agentId) { $0["birthGroup"] = ["chatId": group, "status": row["status"]!] }
                    complete()
                } catch { done(.failure(error)) }
            }
        } else { complete() }
    }

    private func perform(_ operation: GuguIOSCloudOperation, _ done: @escaping (Result<Any, Error>) -> Void) {
        do { try check() } catch { done(.failure(error)); return }
        broker.perform(operation, binding: store.binding) { result in self.queue.async {
            do { try self.check(); done(.success(try result.get())) } catch { done(.failure(error)) }
        } }
    }
    private func resolveModel(_ requested: String?, _ done: @escaping (Result<String, Error>) -> Void) {
        broker.catalog(binding: store.binding, includeHidden: requested != nil) { result in self.queue.async {
            do {
                try self.check(); let models = try result.get()
                if let requested, !requested.hasPrefix("platform:") { throw Self.failure("unsupported", "Phone Agent requires an existing platform model ID") }
                let id = requested.map { String($0.dropFirst("platform:".count)) }
                guard let selected = models.first(where: { id == nil ? $0["requires_membership"] as? Bool != true : $0["id"] as? String == id }), let model = selected["id"] as? String else {
                    throw Self.failure("model_unavailable", "Selected platform model is unavailable")
                }
                done(.success(model))
            } catch { done(.failure(error)) }
        } }
    }
    private func resolveGroup(_ group: String?, _ done: @escaping (Result<String?, Error>) -> Void) {
        guard let group else { done(.success(nil)); return }
        perform(.birthGroup(group)) { result in
            do {
                guard let row = Self.first(try result.get()), row["kind"] as? String == "group", row["status"] as? String != "archived", let id = row["id"] as? String else { throw Self.failure("not_granted", "Birth group is unavailable to the current owner") }
                done(.success(id))
            } catch { done(.failure(error)) }
        }
    }
    private func row(_ raw: Any, intent: [String: Any]) throws -> [String: Any] {
        guard let row = Self.first(raw), row["id"] as? String == intent["provisionId"] as? String,
              row["operation_id"] as? String == intent["operationId"] as? String,
              row["device_id"] as? String == store.binding.deviceId, row["member_key"] as? String == "single" else {
            throw Self.failure("stale_context", "Cloud provision differs from the durable native intent")
        }
        return row
    }
    private func validate(_ input: [String: Any]) throws -> [String: Any] {
        guard let prompt = input["prompt"] as? String, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              (input["harness"] as? String ?? "pi") == "pi", (input["transport"] as? String ?? "acp") == "acp",
              (input["sessionView"] as? String ?? "general") == "general", input["permissionMode"] == nil, input["effort"] == nil else { throw Self.failure("unsupported", "Unsupported phone task input or runtime options") }
        for key in ["projectId", "project_id"] { if let value = input[key] as? String, value != projectId { throw Self.failure("invalid_args", "Task belongs to another phone project") } }
        for key in ["projectPath", "project_path"] { if let value = input[key] as? String, value != projectPath { throw Self.failure("invalid_args", "Task belongs to another phone workspace") } }
        for key in ["model", "chat_id", "chatId"] {
            if let value = input[key], !(value is NSNull), !(value is String) { throw Self.failure("invalid_args", "Task model and chat identifiers must be strings") }
        }
        let name = (input["title"] as? String ?? input["displayName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return ["prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines), "title": (name?.isEmpty == false ? name! : "手机任务 Agent"),
            "model": input["model"] ?? NSNull(), "chatId": input["chat_id"] ?? input["chatId"] ?? NSNull()]
    }
    static func summary(_ agent: [String: Any], projectId: String) -> [String: Any] {
        ["conversationId": agent["sessionId"] ?? NSNull(), "projectId": projectId, "title": agent["displayName"] ?? "手机任务 Agent", "harness": "pi", "runtime": "acp",
         "agentStatus": agent["status"] ?? "idle", "status": ["status": agent["status"] ?? "idle", "detail": "plain"], "lastInteractedAt": agent["lastActiveAt"] ?? NSNull(),
         "supported": true, "agent": ["userId": agent["agentUserId"] ?? NSNull()], "chatId": agent["chatId"] ?? NSNull(), "isPinned": false,
         "parentConversationId": NSNull(), "spawnedByConversationId": NSNull(), "unseen": agent["agentStatusSeen"] as? Int != 1]
    }
    private static func first(_ raw: Any) -> [String: Any]? { (raw as? [[String: Any]])?.first ?? raw as? [String: Any] }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { GuguHostFailure(code: code, message: text) }
}
