import Foundation

extension GuguIOSNativeBackend {
    func route(_ call: GuguIOSHostInvocation, _ completion: @escaping ([String: Any]) -> Void) {
        do {
            try check(call.binding)
            guard binding == call.binding, !stopped, UUID(uuidString: call.requestId) != nil else { throw Self.failure("host_not_ready", "Native task host is unavailable") }
            try GuguIOSCloudBroker.rejectCredentials(call.arguments)
            let result: (Any) -> Void = { completion(["result": $0]) }
            let failed: (Error) -> Void = { completion(Self.replyError($0)) }
            switch call.channel {
            case "appSettings.get", "appSettings.getWithMeta", "appSettings.update":
                guard call.origin == .localOwnerUI, call.arguments.first as? String == "notifications", let store else { throw Self.failure("not_granted", "Only local phone notification settings are available") }
                let settings = GuguIOSLocalAppSettings(store: store)
                if call.channel == "appSettings.update" {
                    try ownerAccess.requireLocalOwnerUI()
                    guard call.arguments.count == 2, let value = call.arguments[1] as? [String: Any] else { throw Self.failure("invalid_args", "Notification settings are required") }
                    try settings.update(value); try check(call.binding); result(NSNull())
                } else {
                    guard call.arguments.count == 1 else { throw Self.failure("invalid_args", "Unexpected settings argument") }
                    result(try call.channel == "appSettings.get" ? settings.get() : settings.getWithMeta())
                }
            case "sessionTimeline.sessionsList":
                let project = try project(call.binding), rows = try records()
                let summaries = rows.map { row -> [String: Any] in
                    var summary = GuguIOSProvisioner.summary(row, projectId: project["id"] as! String)
                    do { try schedulerOrThrow().authorize(agent: row) }
                    catch { summary["supported"] = false; summary["unsupportedReason"] = Self.safe(error).message }
                    return summary
                }
                result(["projects": [project], "sessions": summaries])
            case "sessionTimeline.sessionOfAgent":
                guard let raw = call.arguments.first as? String else { throw Self.failure("invalid_args", "Agent identifier is required") }
                let id = raw.hasPrefix("user:") ? String(raw.dropFirst(5)) : raw
                if let row = try store?.record("agents", id: id) { result(["projectId": try project(call.binding)["id"]!, "sessionId": row["sessionId"]!]) } else { result(NSNull()) }
            case "sessionTimeline.sessionCreateOptions":
                result(["projects": [try project(call.binding)], "harnesses": [["id": "pi", "name": "手机 Agent", "status": "available", "sessionViews": ["general"], "permissionModes": [], "watchable": true, "chatAvailable": false]], "lastUsed": NSNull()])
            case "sessionTimeline.sessionCreateModels":
                let input = call.arguments.first as? [String: Any] ?? [:]
                guard input["harness"] as? String == "pi" else { throw Self.failure("unsupported", "This phone provides only its native Pi runtime") }
                broker.catalog(binding: call.binding) { value in self.queue.async {
                    do {
                        let models = try value.get().map { model -> [String: Any] in ["id": "platform:\(model["id"] as? String ?? "")", "name": model["display_name"] ?? model["id"] ?? "", "source": "gugu", "requires_membership": model["requires_membership"] as? Bool == true] }
                        result(["harness": "pi", "transport": "acp", "models": models, "selected": NSNull(), "efforts": [], "selectedEffort": NSNull(), "harnessState": "auth-required", "harnessReason": NSNull(), "guguReason": NSNull(), "selectedCredential": "uncredentialed"])
                    } catch { failed(error) }
                } }
            case "sessionTimeline.sessionCreate":
                guard let input = call.arguments.first as? [String: Any], let provisioner else { throw Self.failure("invalid_args", "Native creation input is required") }
                provisioner.create(requestId: call.requestId, input: input) { response in
                    switch response { case .success(let value): result(value); case .failure(let error): failed(error) }
                }
            case "sessionTimeline.sessionSend": try send(call, result, failed)
            case "sessionTimeline.sessionSnapshot", "sessionTimeline.sessionAfter", "sessionTimeline.sessionOlder":
                let input = try input(call), row = try agent(input["conversationId"] as? String)
                verify(row, binding: call.binding) { verified in self.queue.async {
                    do {
                        _ = try verified.get()
                        let method = call.channel == "sessionTimeline.sessionSnapshot" ? "snapshot" : call.channel == "sessionTimeline.sessionAfter" ? "after" : "older"
                        try self.schedulerOrThrow().timeline(agent: row, method: method, input: input) { reply in
                            if reply["ok"] as? Bool == true, let value = reply["data"] {
                                self.queue.async { self.verify(row, binding: call.binding) { checked in
                                    do { _ = try checked.get(); result(value) } catch { failed(error) }
                                } }
                            }
                            else { failed(Self.failure(reply["code"] as? String ?? "record_unreadable", reply["message"] as? String ?? "Native timeline cannot be read")) }
                        }
                    } catch { failed(error) }
                } }
            case "sessionTimeline.sessionRespond":
                guard call.origin == .localOwnerUI else { throw Self.failure("not_granted", "Phone permission decisions require local owner UI") }
                try ownerAccess.requireLocalOwnerUI()
                let input = try input(call), row = try agent(input["conversationId"] as? String)
                guard input["kind"] as? String == "permission", let item = input["itemId"] as? String, let option = input["optionId"] as? String else { throw Self.failure("invalid_args", "Native permission decision is incomplete") }
                verify(row, binding: call.binding) { verified in self.queue.async {
                    do {
                        _ = try verified.get(); try self.ownerAccess.requireLocalOwnerUI()
                        try self.schedulerOrThrow().respond(agent: row, requestId: item, option: option) { response in
                            switch response { case .success(let value): result(value); case .failure(let error): failed(error) }
                        }
                    } catch { failed(error) }
                } }
            case "sessionTimeline.sessionCancel":
                let input = try input(call), row = try agent(input["conversationId"] as? String)
                try schedulerOrThrow().cancel(sessionId: row["sessionId"] as! String, requestId: call.requestId) { response in
                    switch response { case .success(let value): result(["cancelled": value]); case .failure(let error): failed(error) }
                }
            case "sessionTimeline.sessionQueue":
                let input = try input(call), row = try agent(input["conversationId"] as? String)
                guard let action = input["action"] as? [String: Any] else { throw Self.failure("invalid_args", "Queue operation is required") }
                try schedulerOrThrow().changeQueue(agent: row, action: action, requestId: call.requestId) { response in
                    switch response { case .success: result(NSNull()); case .failure(let error): failed(error) }
                }
            case "sessionTimeline.sessionOptions": try options(agent: agent(input(call)["conversationId"] as? String), binding: call.binding, result, failed)
            case "sessionTimeline.sessionSetOption", "sessionTimeline.sessionReloadModel":
                let input = try input(call), row = try agent(input["conversationId"] as? String)
                guard (call.channel == "sessionTimeline.sessionSetOption" ? input["dimension"] as? String == "model" : input["modelSource"] as? String == "platform"),
                      let selected = (call.channel == "sessionTimeline.sessionSetOption" ? input["value"] : input["model"]) as? String, !selected.isEmpty else { throw Self.failure("unsupported", "Native phone runtime supports only platform model selection") }
                let id = selected.hasPrefix("platform:") ? String(selected.dropFirst(9)) : selected
                broker.catalog(binding: call.binding, includeHidden: true) { response in self.queue.async {
                    do {
                        guard try response.get().contains(where: { $0["id"] as? String == id }) else { throw Self.failure("model_unavailable", "Selected native platform model is unavailable") }
                        try self.schedulerOrThrow().selectModel(agent: row, modelId: id) { response in self.queue.async {
                            do { _ = try response.get(); try self.options(agent: self.agent(row["sessionId"] as? String), binding: call.binding, result, failed) }
                            catch { failed(error) }
                        } }
                    } catch { failed(error) }
                } }
            case "sessions.markSessionSeen":
                let row = try agent(call.arguments.first as? String)
                guard let store else { throw Self.failure("host_not_ready", "Native registry is unavailable") }
                try store.update("agents", id: row["agentUserId"] as! String) { $0["agentStatusSeen"] = 1 }; result(NSNull()); publish()
            case "sessionTimeline.prefetchFiles", "sessionTimeline.sessionToolImage": throw Self.failure("unsupported", "Native private attachment adapter is not connected")
            default: throw Self.failure("unknown_method", "Native host channel is not implemented")
            }
        } catch { completion(Self.replyError(error, admission: "rejected")) }
    }
    func send(_ call: GuguIOSHostInvocation, _ result: @escaping (Any) -> Void, _ failed: @escaping (Error) -> Void) throws {
        let input = try input(call)
        guard input["steerIfBusy"] as? Bool != true else { throw Self.failure("unsupported", "Native phone task does not support steering a running turn") }
        guard let text = input["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let raw = input["conversationId"] as? String else { throw Self.failure("invalid_args", "Task text and conversation are required") }
        if let files = input["files"] as? [Any], !files.isEmpty { throw Self.failure("unsupported", "Native private attachment adapter is not connected") }
        let session = bareSession(raw), client = input["clientRequestId"] as? String ?? call.requestId
        guard UUID(uuidString: client) != nil, UUID(uuidString: session) != nil else { throw Self.failure("invalid_args", "Original client and session IDs must be UUIDs") }
        let id = try GuguIOSStableID.strings("phone-task-input", call.binding.ownerId, session, client), prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let fingerprint = try GuguHostJournal.digest(["sessionId": session, "text": prompt, "clientMessageId": client])
        if let prior = try store?.record("inputs", id: id) {
            guard prior["fingerprint"] as? String == fingerprint else { throw Self.failure("duplicate_conflict", "Original task input cannot change content") }
            result(["accepted": true, "messageId": id, "admission": "accepted"]); return
        }
        let row = try agent(session)
        verify(row, binding: call.binding) { verified in self.queue.async {
            do {
                _ = try verified.get()
                try self.schedulerOrThrow().admit(agent: row, text: prompt, id: id, clientMessageId: client) { response in
                    switch response {
                    case .success: result(["accepted": true, "messageId": id, "admission": "accepted"])
                    case .failure(let error): failed(error)
                    }
                }
            } catch { failed(error) }
        } }
    }
    func options(agent: [String: Any], binding: GuguIOSHostBinding, _ result: @escaping (Any) -> Void, _ failed: @escaping (Error) -> Void) throws {
        guard let modelId = agent["modelId"] as? String else { throw Self.failure("invalid_journal", "Native model selection is missing") }
        broker.catalog(binding: binding) { response in
            do {
                let models = try response.get()
                result(["mode": NSNull(), "effort": NSNull(), "model": ["selected": "platform:\(modelId)", "available": models.map { ["id": "platform:\($0["id"] as? String ?? "")", "name": $0["display_name"] ?? $0["id"] ?? ""] }],
                    "modelMenu": ["conversationSelection": ["modelId": modelId], "agentName": "手机 Agent", "platformModels": models.map { row -> [String: Any] in
                        ["id": row["id"] ?? "", "displayName": row["display_name"] ?? row["id"] ?? "", "creditMultiplier": row["credit_multiplier"] ?? NSNull(), "contextWindow": row["context_window"] ?? NSNull(), "reasoningEfforts": NSNull(), "requiresMembership": row["requires_membership"] as? Bool == true, "hidden": row["hidden"] as? Bool == true]
                    }, "ownCatalog": NSNull(), "ownAuth": NSNull(), "liveSetting": ["channel": "acp-config-option", "ack": "ack-read-back", "busy": "reject", "reloadRequired": false, "recovery": "none"]]])
            } catch { failed(error) }
        }
    }
    func input(_ call: GuguIOSHostInvocation) throws -> [String: Any] {
        guard let input = call.arguments.first as? [String: Any] else { throw Self.failure("invalid_args", "Native task request is missing") }; return input
    }
    func records() throws -> [[String: Any]] { Array((try store?.snapshot()["agents"] as? [String: [String: Any]] ?? [:]).values) }
    func agent(_ id: String?) throws -> [String: Any] {
        guard let id, let expected = binding else { throw Self.failure("invalid_args", "Native conversation is required") }
        guard let row = try records().first(where: { $0["sessionId"] as? String == bareSession(id) }), row["ownerId"] as? String == expected.ownerId, row["deviceId"] as? String == expected.deviceId else { throw Self.failure("SESSION_NOT_FOUND", "This phone has no bound native session") }; return row
    }
    func bareSession(_ id: String) -> String { id.hasPrefix("session:") ? String(id.dropFirst(8)) : id }
    func verify(_ agent: [String: Any], binding: GuguIOSHostBinding, completion: @escaping (Result<Void, Error>) -> Void) {
        guard self.binding == binding, let sources else { completion(.failure(Self.failure("stale_context", "Native source authority changed"))); return }
        guard let id = agent["agentUserId"] as? String, let session = agent["sessionId"] as? String, let epoch = agent["contextEpoch"] as? String else { completion(.failure(Self.failure("invalid_journal", "Native Agent binding is missing"))); return }
        sources.authorizeSession(agentId: id, sessionId: session, contextEpoch: epoch, completion: completion)
    }
    func schedulerOrThrow() throws -> GuguIOSTaskScheduler { guard let scheduler else { throw Self.failure("host_not_ready", "Native task scheduler is unavailable") }; return scheduler }
}
