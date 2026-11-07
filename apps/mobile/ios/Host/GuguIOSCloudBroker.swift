import Foundation

/// Only existing public cloud operations. No schema, RPC name or URL is supplied
/// by a renderer/tool call. Model credentials have a separate native-only path.
enum GuguIOSCloudOperation {
    case registerDevice([String: Any])
    case heartbeat(instanceId: String)
    case activeAgent(String)
    case startProvision(operationId: String, provisionId: String, displayName: String, modelId: String)
    case readProvision(String)
    case claimProvision(operationId: String, retryProvisionId: String?)
    case prepareProvision([String: Any])
    case readCommand(String)
    case settleProvision(String)
    case completeProvision(String)
    case pendingCommands(perAgent: Int)
    case recoverCommands
    case claimCommand(id: String, claimToken: String, instanceId: String, at: String)
    case recheckCommand(id: String, claimToken: String)
    case completeCommand(id: String, claimToken: String, result: [String: Any], at: String)
    case inbox(agentId: String, chatId: String?, afterSeq: Int?, scanAfter: [String: Any]?, scanFence: Int?)
    case markRead(agentId: String, chatId: String, messageId: String)
    case runtimeState([String: Any])
    case modelSelection(agentId: String, modelId: String)
    case sendMessage([String: Any])
    case birthGroup(String)
    case joinBirthGroup(chatId: String, agentId: String)
}

private final class GuguIOSBrokerRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class GuguIOSCloudBroker {
    typealias Credentials = (GuguIOSHostBinding) throws -> GuguIOSOwnerCredentials
    typealias Send = (URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> Void
    private let root: URL
    private let anonKey: String
    private let credentials: Credentials
    private let send: Send
    private let redirects: GuguIOSBrokerRedirects?
    private let session: URLSession?

    init(configuration: GuguIOSBackendConfiguration, credentials: @escaping Credentials, send: Send? = nil) throws {
        root = try configuration.baseURL(); anonKey = configuration.anonKey; self.credentials = credentials
        if let send { self.send = send; redirects = nil; session = nil }
        else {
            let redirects = GuguIOSBrokerRedirects(), config = URLSessionConfiguration.ephemeral
            config.httpCookieStorage = nil; config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 45
            let session = URLSession(configuration: config, delegate: redirects, delegateQueue: nil)
            self.session = session; self.redirects = redirects
            self.send = { request, done in session.dataTask(with: request, completionHandler: done).resume() }
        }
    }

    func perform(_ operation: GuguIOSCloudOperation, binding: GuguIOSHostBinding,
                 completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            let spec = try specification(operation, binding: binding)
            try Self.rejectCredentials(spec.body)
            request(binding: binding, path: spec.path, method: spec.method, schema: spec.schema,
                    query: spec.query, body: spec.body, prefer: spec.prefer, completion: completion)
        } catch { completion(.failure(error)) }
    }

    /// Internal model-access transport; its credential-bearing result must never
    /// be returned to the generic host-call adapter or written to the journal.
    func modelAccess(binding: GuguIOSHostBinding, body: [String: Any], completion: @escaping (Result<Any, Error>) -> Void) {
        guard let action = body["action"] as? String, ["catalog", "issue", "renew", "checkpoint", "revoke"].contains(action) else {
            completion(.failure(Self.failure("invalid_args", "Unknown model access operation"))); return
        }
        request(binding: binding, path: "functions/v1/model-access", method: "POST", schema: nil, query: [], body: body, prefer: nil, completion: completion)
    }

    private func request(binding: GuguIOSHostBinding, path: String, method: String, schema: String?,
                         query: [URLQueryItem], body: [String: Any]?, prefer: String?,
                         completion: @escaping (Result<Any, Error>) -> Void) {
        do {
            try binding.validate()
            let ticket = try credentials(binding)
            guard ticket.binding == binding, ticket.expiresAt > Date(), !ticket.accessToken.isEmpty,
                  !ticket.accessToken.contains("\r"), !ticket.accessToken.contains("\n") else { throw Self.failure("auth_unavailable", "Native owner credentials are unavailable") }
            var components = URLComponents(url: root.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
            if !query.isEmpty { components.queryItems = query }
            guard let url = components.url else { throw Self.failure("invalid_args", "Cannot encode cloud operation") }
            var request = URLRequest(url: url)
            request.httpMethod = method; request.timeoutInterval = 30
            request.setValue(anonKey, forHTTPHeaderField: "apikey")
            request.setValue("Bearer \(ticket.accessToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let schema { request.setValue(schema, forHTTPHeaderField: method == "GET" ? "Accept-Profile" : "Content-Profile") }
            if let prefer { request.setValue(prefer, forHTTPHeaderField: "Prefer") }
            if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes]) }
            send(request) { bytes, response, error in
                do {
                    // Native publication is checked again before any data leaves
                    // the broker, including same-owner token rotation/retirement.
                    let current = try self.credentials(binding)
                    guard current.binding == binding, current.accessToken == ticket.accessToken, current.expiresAt > Date() else {
                        throw Self.failure("stale_context", "Native owner credentials changed during cloud operation")
                    }
                    guard error == nil else { throw Self.failure("cloud_transport_uncertain", "Cloud request did not return a known result") }
                    guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
                        throw Self.failure("cloud_http_error", "Cloud HTTP status \((response as? HTTPURLResponse)?.statusCode ?? 0)")
                    }
                    guard let bytes, !bytes.isEmpty else { completion(.success(NSNull())); return }
                    let value: Any
                    do { value = try JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed]) }
                    catch { throw Self.failure("cloud_protocol_error", "Cloud response is not valid JSON") }
                    completion(.success(value))
                } catch { completion(.failure(error)) }
            }
        } catch { completion(.failure(error)) }
    }

    private struct Spec {
        let path: String
        var method = "POST"
        var schema: String? = "identity"
        var body: [String: Any]? = nil
        var query: [URLQueryItem] = []
        var prefer: String? = nil
    }
    private func specification(_ operation: GuguIOSCloudOperation, binding b: GuguIOSHostBinding) throws -> Spec {
        func rpc(_ name: String, _ body: [String: Any], schema: String = "identity") -> Spec {
            Spec(path: "rest/v1/rpc/\(name)", schema: schema, body: body)
        }
        func read(_ table: String, _ fields: String, _ filters: [(String, String)]) -> Spec {
            Spec(path: "rest/v1/\(table)", method: "GET", query: [URLQueryItem(name: "select", value: fields)] + filters.map { URLQueryItem(name: $0.0, value: "eq.\($0.1)") })
        }
        func id(_ value: String) throws -> String {
            guard UUID(uuidString: value) != nil else { throw Self.failure("invalid_args", "Cloud identity must be a UUID") }; return value
        }
        switch operation {
        case .registerDevice(let row):
            guard row["device_id"] as? String == b.deviceId, row["user_id"] as? String == b.ownerId else { throw Self.failure("stale_context", "Device registration differs from native binding") }
            return Spec(path: "rest/v1/gugu_devices", body: row, query: [.init(name: "on_conflict", value: "device_id")], prefer: "resolution=merge-duplicates,return=representation")
        case .heartbeat(let instance): return rpc("runtime_instance_heartbeat", ["p_instance_id": try id(instance), "p_device_id": b.deviceId])
        case .activeAgent(let agent): return read("active_users", "id,type,owner_user_id,device_id,display_name,gugu_number,desired_status", [("id", try id(agent)), ("owner_user_id", b.ownerId), ("device_id", b.deviceId), ("type", "agent")])
        case .startProvision(let operation, let provision, let name, let model):
            let member: [String: Any] = ["provision_id": try id(provision), "member_key": "single", "display_name": name, "agent_type": "pi", "inherit_memory": false, "history_import_required": false]
            return rpc("start_agent_provision_operation", ["p_operation_id": try id(operation), "p_device_id": b.deviceId,
                "p_blueprint": ["kind": "single", "concurrency_limit": 1, "members": [member]], "p_memory_content": NSNull(),
                "p_initial_message": NSNull(), "p_model": "platform:\(model)", "p_effort": NSNull(), "p_permission_mode": NSNull()])
        case .readProvision(let value): return read("agent_provisions", "*", [("id", try id(value))])
        case .claimProvision(let operation, let retry): return rpc("claim_provision_slots", ["p_operation_id": try id(operation), "p_limit": 1, "p_retry_provision_ids": try retry.map { [try id($0)] } as Any? ?? NSNull()])
        case .prepareProvision(let row):
            guard row["device_id"] as? String == b.deviceId else { throw Self.failure("stale_context", "Provision targets another device") }
            var args: [String: Any] = [:]
            for key in ["id", "operation_id", "member_key", "device_id", "display_name", "agent_type", "project_path", "avatar", "special_focus", "initial_message_id", "initial_message_text"] {
                args["p_\(key == "id" ? "provision_id" : key)"] = row[key] ?? NSNull()
            }
            return rpc("prepare_agent_provision", args)
        case .readCommand(let value): return read("gugu_device_commands", "*", [("id", try id(value)), ("device_id", b.deviceId)])
        case .settleProvision(let value): return rpc("settle_agent_provision_terminal", ["p_provision_id": try id(value)])
        case .completeProvision(let value): return rpc("complete_agent_provision", ["p_provision_id": try id(value)])
        case .pendingCommands(let count):
            guard count > 0 else { throw Self.failure("invalid_args", "Invalid command batch") }
            return rpc("fetch_fair_pending_device_commands", ["p_device_id": b.deviceId, "p_per_agent": count])
        case .recoverCommands: return rpc("recover_orphaned_device_commands", ["p_device_id": b.deviceId])
        case .claimCommand(let command, let token, let instance, let at):
            return Spec(path: "rest/v1/gugu_device_commands", method: "PATCH", body: ["status": "running", "claimed_at": at, "claim_token": try id(token), "claimed_by": try id(instance)],
                query: [.init(name: "id", value: "eq.\(try id(command))"), .init(name: "device_id", value: "eq.\(b.deviceId)"), .init(name: "status", value: "eq.pending"), .init(name: "select", value: "id,claim_token")], prefer: "return=representation")
        case .recheckCommand(let command, let token): return rpc("recheck_device_command_execution", ["p_id": try id(command), "p_claim_token": try id(token)])
        case .completeCommand(let command, let token, let result, let at):
            return Spec(path: "rest/v1/gugu_device_commands", method: "PATCH", body: ["status": "done", "result": result, "completed_at": at, "error": NSNull(), "claim_token": NSNull()],
                query: [.init(name: "id", value: "eq.\(try id(command))"), .init(name: "device_id", value: "eq.\(b.deviceId)"), .init(name: "claim_token", value: "eq.\(try id(token))"), .init(name: "status", value: "eq.running"), .init(name: "select", value: "id")], prefer: "return=representation")
        case .inbox(let agent, let chat, let seq, let scan, let fence):
            return rpc("pull_agent_inbox_v2", ["p_agent_user_id": try id(agent), "p_chat_id": try chat.map(id) as Any? ?? NSNull(), "p_after_seq": seq as Any? ?? NSNull(), "p_limit": 80, "p_scan_after": scan as Any? ?? NSNull(), "p_scan_max_ingest_seq": fence as Any? ?? NSNull()])
        case .markRead(let agent, let chat, let message): return rpc("mark_read_on_deliver", ["p_user_id": try id(agent), "p_chat_id": try id(chat), "p_message_id": try id(message)])
        case .runtimeState(let body): return rpc("set_agent_runtime_state", body)
        case .modelSelection(let agent, let model): return rpc("report_agent_model_selection", ["p_agent_user_id": try id(agent), "p_applied": ["source": "platform", "modelId": model], "p_error": NSNull()])
        case .sendMessage(let body): return rpc("send_message_idempotent", body, schema: "chat")
        case .birthGroup(let target):
            let numeric = !target.isEmpty && target.allSatisfy { $0.isASCII && $0.isNumber }
            return Spec(path: "rest/v1/chats", method: "GET", schema: "chat", query: [.init(name: "select", value: "id,kind,status"), .init(name: numeric ? "public_id" : "id", value: "eq.\(numeric ? target : try id(target))")])
        case .joinBirthGroup(let chat, let agent): return rpc("add_group_agent", ["p_chat_id": try id(chat), "p_agent_user_id": try id(agent), "p_message": NSNull(), "p_as_user_id": b.ownerId, "p_as_task": true], schema: "chat")
        }
    }

    static func rejectCredentials(_ value: Any?) throws {
        if let object = value as? [String: Any] {
            for (key, item) in object {
                guard !["accessToken", "access_token", "refreshToken", "refresh_token", "apiKey", "api_key", "Authorization", "token"].contains(key) else {
                    throw failure("invalid_args", "Credentials are not part of durable cloud operations")
                }
                try rejectCredentials(item)
            }
        } else if let items = value as? [Any] { for item in items { try rejectCredentials(item) } }
    }
    static func failure(_ code: String, _ text: String) -> GuguHostFailure { GuguHostFailure(code: code, message: text) }
    deinit { session?.invalidateAndCancel() }
}
