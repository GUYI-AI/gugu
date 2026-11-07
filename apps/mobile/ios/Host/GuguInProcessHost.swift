import Foundation

/// Native coordinator for the packaged Pi loop. This is intentionally not a
/// GuguAgent/Capacitor capability declaration; renderer/cloud admission is separate.
final class GuguInProcessHost {
    private struct Pending {
        let request: GuguNativeToolRequest
        let reply: GuguJavaScriptRuntime.Reply
    }
    private let journal: GuguHostJournal
    private let executor: GuguNativeToolExecutor
    private let model: GuguModelCompleting?
    private let currentIdentity: () -> (ownerId: String, installationId: String)
    private let emit: ([String: Any]) -> Void
    private let pendingLock = NSLock()
    private var pending: [String: Pending] = [:]
    private var runtime: GuguJavaScriptRuntime!
    private var stopped = false
    let runtimeInstanceId = UUID().uuidString.lowercased()

    init(asset: Data, expectedSHA256: String, journal: GuguHostJournal,
         executor: GuguNativeToolExecutor, model: GuguModelCompleting?,
         currentIdentity: @escaping () -> (ownerId: String, installationId: String),
         event: @escaping ([String: Any]) -> Void) throws {
        self.journal = journal
        self.executor = executor
        self.model = model
        self.currentIdentity = currentIdentity
        emit = event
        runtime = try GuguJavaScriptRuntime(asset: asset, expectedSHA256: expectedSHA256, request: { [weak self] request, reply in
            self?.handle(request, reply: reply)
        }, cancel: { [weak self] id in self?.cancelNative(id) }, event: { [weak self] event in self?.deliver(event) })
    }

    func diagnostics() throws -> [String: Any] { try runtime.diagnostics() }

    func start(context: GuguHostContext, prompt: String, modelId: String, systemPrompt: String,
               tools: [[String: Any]]) throws -> [String: Any] {
        try start(context: context, prompt: prompt, modelId: modelId, systemPrompt: systemPrompt, tools: tools, messages: [])
    }

    private func start(context: GuguHostContext, prompt: String, modelId: String, systemPrompt: String,
                       tools: [[String: Any]], messages: [[String: Any]]) throws -> [String: Any] {
        try checkCurrent(context)
        guard try journal.admit(context, prompt: prompt, modelId: modelId, systemPrompt: systemPrompt, tools: tools, messages: messages) else {
            return ["accepted": false, "jobId": context.jobId, "status": try journal.job(context.jobId)["status"] ?? "unknown"]
        }
        do {
            try runtime.start(["context": GuguHostJournal.object(context), "prompt": prompt,
                "modelId": modelId, "systemPrompt": systemPrompt, "tools": tools, "messages": messages])
        } catch {
            try journal.finish(context, result: ["status": "failed", "error": "Cannot start packaged runtime", "text": ""])
            throw error
        }
        return ["accepted": true, "jobId": context.jobId]
    }

    func readTask(jobId: String) throws -> [String: Any] {
        let job = try journal.job(jobId)
        guard let raw = job["context"] as? [String: Any] else { throw failure("invalid_journal", "Task binding is missing") }
        let historical = try GuguHostJournal.context(raw)
        guard job["contextInvalidated"] as? Bool != true else { throw failure("not_granted", "This protected task context was revoked") }
        let guardOnly = GuguNativeToolControl(checkActive: { [weak self] in
            guard let self else { throw GuguHostFailure(code: "cancelled", message: "Host has stopped") }
            try self.checkHistoricalIdentity(historical)
        }, beginMutation: { throw GuguHostFailure(code: "not_granted", message: "History read cannot authorize writes") },
           finishMutation: { _ in throw GuguHostFailure(code: "not_granted", message: "History read has no write receipt") })
        try guardOnly.checkActive()
        if job["usedCalendar"] as? Bool == true {
            do { try executor.validateAccess(guardOnly) }
            catch { if isPermissionFailure(error) { try revokeCalendarAccess() }; throw error }
        }
        var view = job
        view["nativeCalls"] = try journal.calls(jobId: jobId)
        return view
    }

    /// Explicit owner continuation uses a new job ID. Initialization never resumes
    /// a task or replays a write automatically. Revoked history is not copied.
    func continueTask(previousJobId: String, context: GuguHostContext, prompt: String,
                      modelId: String, systemPrompt: String, tools: [[String: Any]]) throws -> [String: Any] {
        let previous = try readTask(jobId: previousJobId)
        guard let raw = previous["context"] as? [String: Any] else { throw failure("invalid_journal", "Task binding is missing") }
        let historical = try GuguHostJournal.context(raw)
        guard historical.sessionId == context.sessionId, historical.agentUserId == context.agentUserId,
              historical.contextEpoch == context.contextEpoch, historical.jobId != context.jobId else {
            throw failure("stale_context", "Continuation must bind the same session context and a new task turn")
        }
        let messages = try journal.continuationTranscript(jobId: previousJobId)
        return try start(context: context, prompt: prompt, modelId: modelId, systemPrompt: systemPrompt, tools: tools, messages: messages)
    }

    func cancel(context: GuguHostContext) throws {
        try checkCurrent(context)
        try journal.cancel(context)
        try runtime.cancel(context)
        emit(["type": "task_status", "jobId": context.jobId, "status": "cancelled"])
    }

    /// Category-off and every reconnect must notify this hook before re-enabling.
    /// An observed OS revocation also enters it. Re-grant does not revive old context.
    func revokeCalendarAccess() throws {
        for context in try journal.invalidateCalendarContexts() {
            try runtime.cancelAsynchronously(context)
        }
        emit(["type": "calendar_context_revoked"])
    }

    func stop() throws {
        pendingLock.lock(); stopped = true; pendingLock.unlock()
        var failure: Error?
        for context in try journal.activeContexts(runtimeInstanceId: runtimeInstanceId) {
            do { try journal.cancel(context); try runtime.cancel(context) }
            catch { failure = error }
        }
        if let failure { throw failure }
    }

    /// Call only from the authenticated owner's local native task UI. This is
    /// absent from the JSC request allowlist and cannot be invoked by a model.
    func approve(requestId: String, nativeOwnerId: String) throws {
        let pair = pendingValue(requestId: requestId)
        guard let pair, nativeOwnerId == currentIdentity().ownerId,
              pair.1.request.context.ownerId == nativeOwnerId else {
            throw GuguHostFailure(code: "not_granted", message: "Approval requires the current native owner")
        }
        try checkActive(pair.1.request.context)
        try executor.validateAccess(control(for: pair.1.request))
        try journal.approve(pair.1.request)
        execute(pair.0, pair.1)
    }

    private func handle(_ bridge: GuguBridgeRequest, reply: @escaping GuguJavaScriptRuntime.Reply) {
        do {
            guard let raw = bridge.payload["context"] as? [String: Any] else { throw failure("invalid_args", "Task context is missing") }
            let context = try GuguHostJournal.context(raw)
            try checkCurrent(context)
            switch bridge.method {
            case "journal.event":
                try checkDataAccess(context)
                guard let event = bridge.payload["event"] as? [String: Any] else { throw failure("invalid_args", "Pi event is missing") }
                try journal.record(context, event: event, messages: bridge.payload["messages"] as? [[String: Any]])
                reply(["ok": true, "data": [:]])
            case "turn.finished":
                try journal.finish(context, result: bridge.payload)
                reply(["ok": true, "data": [:]])
                emit(["type": "task_status", "jobId": context.jobId, "status": try journal.job(context.jobId)["status"] ?? "failed"])
            case "model.complete":
                try checkDataAccess(context)
                guard let body = bridge.payload["body"] as? [String: Any], let model else { throw failure("model_ticket_missing", "A real assigned model lease is required") }
                model.complete(id: bridge.id, context: context, body: body) { [weak self] result in
                    guard let self else { return }
                    do { try self.checkDataAccess(context); reply(result) }
                    catch { reply(self.envelope(error)) }
                }
            case "tool.execute":
                try checkActive(context)
                guard let action = bridge.payload["actionName"] as? String,
                      let args = bridge.payload["args"] as? [String: Any],
                      let callId = bridge.payload["toolCallId"] as? String else { throw failure("invalid_args", "Native tool payload is incomplete") }
                let deadline = Int64(Date().timeIntervalSince1970 * 1000) + 15 * 60 * 1000
                let (request, prior) = try journal.admitTool(context, toolCallId: callId, action: action, arguments: args, deadlineAtMs: deadline)
                let access = control(for: request)
                try executor.validateAccess(access)
                if let prior {
                    switch prior["status"] as? String {
                    case "completed":
                        guard let receipt = prior["receipt"] as? [String: Any] else { throw failure("invalid_journal", "Saved receipt is missing") }
                        try executor.validateAccess(access)
                        reply(["ok": true, "data": receipt])
                    case "execution_unknown": throw failure("execution_unknown", "A previous write has no confirmed result; do not replay")
                    default: throw failure("duplicate_conflict", "This native request is already pending or interrupted")
                    }
                    return
                }
                let entry = Pending(request: request, reply: reply)
                pendingLock.lock(); pending[bridge.id] = entry; pendingLock.unlock()
                if action == "calendar.events.list" { execute(bridge.id, entry) }
                else {
                    try checkActive(context)
                    emit(["type": "confirmation_pending", "context": raw, "requestId": request.requestId,
                          "toolCallId": request.toolCallId, "actionName": action,
                          "argumentsJSON": request.argumentsJSON, "argumentsSHA256": request.argumentsSHA256,
                          "deadlineAtMs": request.deadlineAtMs])
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 15 * 60) { [weak self] in self?.expire(bridge.id) }
            default: throw failure("unknown_action", "Native bridge method is not available")
            }
        } catch { reply(envelope(error)) }
    }

    private func execute(_ id: String, _ entry: Pending) {
        executor.execute(entry.request, control: control(for: entry.request)) { [weak self] result in
            guard let self, let pending = self.removePending(id) else { return }
            do {
                let receipt = try self.journal.completeTool(pending.request, result: result)
                try self.executor.validateAccess(self.control(for: pending.request))
                pending.reply(["ok": true, "data": receipt])
            } catch { pending.reply(self.envelope(error)) }
        }
    }

    private func control(for request: GuguNativeToolRequest) -> GuguNativeToolControl {
        GuguNativeToolControl(checkActive: { [weak self] in
            guard let self else { throw GuguHostFailure(code: "cancelled", message: "Host has stopped") }
            try self.checkActive(request.context)
            try self.journal.checkDeadline(request)
        }, beginMutation: { [weak self] in
            guard let self else { throw GuguHostFailure(code: "cancelled", message: "Host has stopped") }
            try self.checkActive(request.context)
            try self.journal.beginMutation(request)
        }, finishMutation: { [journal] result in try journal.finishMutation(request, result: result) })
    }

    private func checkHistoricalIdentity(_ context: GuguHostContext) throws {
        pendingLock.lock(); let isStopped = stopped; pendingLock.unlock()
        let identity = currentIdentity()
        guard !isStopped, identity.ownerId == context.ownerId, identity.installationId == context.installationId else {
            throw failure("stale_context", "Account or native installation changed")
        }
    }
    private func checkCurrent(_ context: GuguHostContext) throws {
        pendingLock.lock(); let isStopped = stopped; pendingLock.unlock()
        let identity = currentIdentity()
        guard !isStopped, identity.ownerId == context.ownerId, identity.installationId == context.installationId,
              context.runtimeInstanceId == runtimeInstanceId else { throw failure("stale_context", "Account, installation or runtime instance changed") }
    }
    private func checkActive(_ context: GuguHostContext) throws { try checkCurrent(context); try journal.checkActive(context) }
    private func checkDataAccess(_ context: GuguHostContext) throws {
        try checkActive(context)
        if try journal.job(context.jobId)["usedCalendar"] as? Bool == true {
            let guardOnly = GuguNativeToolControl(checkActive: { [weak self] in
                guard let self else { throw GuguHostFailure(code: "cancelled", message: "Host has stopped") }
                try self.checkActive(context)
            }, beginMutation: { throw GuguHostFailure(code: "not_granted", message: "Read guard cannot authorize a write") },
               finishMutation: { _ in throw GuguHostFailure(code: "not_granted", message: "Read guard has no write receipt") })
            do { try executor.validateAccess(guardOnly) }
            catch { if isPermissionFailure(error) { try revokeCalendarAccess() }; throw error }
        }
    }
    private func isPermissionFailure(_ error: Error) -> Bool {
        guard let code = (error as? GuguHostFailure)?.code else { return false }
        return ["not_granted", "os_permission"].contains(code)
    }
    private func deliver(_ event: [String: Any]) {
        do {
            if let raw = event["context"] as? [String: Any] {
                try checkDataAccess(GuguHostJournal.context(raw))
            }
            emit(event)
        } catch {
            emit(["type": "protected_event_withheld", "code": (error as? GuguHostFailure)?.code ?? "host_failed"])
        }
    }
    private func cancelNative(_ id: String) {
        model?.cancel(id: id)
        if let entry = removePending(id) {
            entry.reply(failure("cancelled", "Native request was cancelled").envelope)
        }
    }
    private func expire(_ id: String) {
        guard let entry = removePending(id) else { return }
        do {
            let result = try journal.completeTool(entry.request, result: failure("expired", "Native operation expired").envelope)
            entry.reply(["ok": true, "data": result])
        } catch { entry.reply(envelope(error)) }
    }
    private func pendingValue(requestId: String) -> (String, Pending)? {
        pendingLock.lock(); defer { pendingLock.unlock() }
        return pending.first(where: { $0.value.request.requestId == requestId }).map { ($0.key, $0.value) }
    }
    private func removePending(_ id: String) -> Pending? {
        pendingLock.lock(); defer { pendingLock.unlock() }
        return pending.removeValue(forKey: id)
    }
    private func failure(_ code: String, _ message: String) -> GuguHostFailure { GuguHostFailure(code: code, message: message) }
    private func envelope(_ error: Error) -> [String: Any] {
        (error as? GuguHostFailure ?? GuguHostFailure(code: "host_failed", message: error.localizedDescription)).envelope
    }
}
