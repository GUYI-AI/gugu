import Foundation
import CryptoKit
import Darwin

/// All handles for one journal share a recursive transaction lock. The stable
/// sidecar file also excludes writers in another process across atomic renames.
final class GuguJournalFileLock {
    private final class Entry {
        let mutex = NSRecursiveLock()
        var depth = 0
        var descriptor: Int32 = -1
    }
    private static let registryLock = NSLock()
    private static var registry: [String: Entry] = [:]
    private let entry: Entry
    private let path: String

    init(url: URL) {
        path = url.resolvingSymlinksInPath().standardizedFileURL.path + ".lock"
        Self.registryLock.lock()
        defer { Self.registryLock.unlock() }
        if let existing = Self.registry[path] { entry = existing }
        else { let created = Entry(); Self.registry[path] = created; entry = created }
    }

    func lock() throws {
        entry.mutex.lock()
        if entry.depth == 0 {
            let descriptor = open(path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
            guard descriptor >= 0 else { entry.mutex.unlock(); throw Self.ioError() }
            while flock(descriptor, LOCK_EX) != 0 {
                let code = errno
                if code == EINTR { continue }
                close(descriptor)
                entry.mutex.unlock()
                throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
            }
            entry.descriptor = descriptor
        }
        entry.depth += 1
    }

    func unlock() {
        entry.depth -= 1
        if entry.depth == 0 {
            flock(entry.descriptor, LOCK_UN)
            close(entry.descriptor)
            entry.descriptor = -1
        }
        entry.mutex.unlock()
    }

    private static func ioError() -> POSIXError { POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
}

/// The native owner-scoped journal is authoritative for task and write admission.
/// Each transaction is persisted before it replaces the in-memory state.
final class GuguHostJournal {
    private let lock: GuguJournalFileLock
    private let url: URL
    private let ownerId: String
    private let installationId: String
    private var state: [String: Any]

    init(root: URL, ownerId: String, installationId: String) throws {
        guard UUID(uuidString: ownerId) != nil, UUID(uuidString: installationId) != nil else {
            throw GuguHostFailure(code: "invalid_args", message: "Invalid native owner or installation")
        }
        self.ownerId = ownerId
        self.installationId = installationId
        let directory = root.appendingPathComponent(ownerId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(values)
        url = directory.appendingPathComponent("host.json")
        lock = GuguJournalFileLock(url: url)
        state = ["version": 1, "ownerId": ownerId, "installationId": installationId,
                 "jobs": [String: Any](), "calls": [String: Any]()]
        try lock.lock(); defer { lock.unlock() }
        if FileManager.default.fileExists(atPath: url.path) {
            state = try readLatest()
        } else {
            try persist(state)
        }
        try update { next in
            var jobs = next["jobs"] as? [String: [String: Any]] ?? [:]
            for (id, var job) in jobs where ["running", "needs_user", "queued"].contains(job["status"] as? String ?? "") {
                job["status"] = "interrupted"
                job["error"] = "Process stopped; explicitly continue the task after checking uncertain writes"
                jobs[id] = job
            }
            var calls = next["calls"] as? [String: [String: Any]] ?? [:]
            for (id, var call) in calls {
                switch call["status"] as? String {
                case "executing" where call["mutationClaimed"] as? Bool == true:
                    call["status"] = "execution_unknown"
                case "admitted", "executing", "needs_confirmation", "approved":
                    call["status"] = "interrupted"
                default: continue
                }
                calls[id] = call
            }
            next["jobs"] = jobs
            next["calls"] = calls
        }
    }

    func admit(_ context: GuguHostContext, prompt: String, modelId: String, systemPrompt: String = "", tools: [[String: Any]] = [], messages: [[String: Any]] = [], calendarProtected: Bool = false) throws -> Bool {
        try lock.lock(); defer { lock.unlock() }
        try validate(context)
        return try update { next in
            var jobs = next["jobs"] as? [String: [String: Any]] ?? [:]
            let binding = try Self.object(context)
            var fingerprint: [String: Any] = ["context": binding, "prompt": prompt, "modelId": modelId, "systemPrompt": systemPrompt, "tools": tools, "messages": messages]
            if calendarProtected { fingerprint["calendarProtected"] = true }
            let digest = try Self.digest(fingerprint)
            if let saved = jobs[context.jobId] {
                guard saved["inputSHA256"] as? String == digest else { throw Self.failure("duplicate_conflict", "Job ID has different input or binding") }
                return false
            }
            if jobs.values.contains(where: { job in
                guard ["running", "needs_user"].contains(job["status"] as? String ?? ""),
                      let prior = job["context"] as? [String: Any] else { return false }
                return prior["sessionId"] as? String == context.sessionId
            }) { throw Self.failure("session_busy", "This session already has an active native turn") }
            if jobs.values.contains(where: { job in
                guard job["contextInvalidated"] as? Bool == true, let prior = job["context"] as? [String: Any] else { return false }
                return prior["sessionId"] as? String == context.sessionId && prior["contextEpoch"] as? String == context.contextEpoch
            }) { throw Self.failure("not_granted", "Revoked task context must not be reused") }
            let sequence = (next["nextJobSequence"] as? Int ?? 0) + 1
            next["nextJobSequence"] = sequence
            jobs[context.jobId] = ["context": binding, "prompt": prompt, "modelId": modelId,
                                   "admissionSequence": sequence, "admittedAtMs": Int64(Date().timeIntervalSince1970 * 1000),
                                   "inputSHA256": digest, "status": "running", "events": [[String: Any]](), "messages": [[String: Any]]()]
            // A native continuation carries the source data category before its
            // first journal event or model request, even without another tool call.
            if calendarProtected { jobs[context.jobId]?["usedCalendar"] = true }
            next["jobs"] = jobs
            return true
        }
    }

    func checkActive(_ context: GuguHostContext) throws {
        try validate(context)
        try lock.lock(); defer { lock.unlock() }
        state = try readLatest()
        guard let job = (state["jobs"] as? [String: [String: Any]])?[context.jobId],
              let binding = job["context"] as? [String: Any], try Self.context(binding) == context else {
            throw Self.failure("stale_context", "Task binding is no longer current")
        }
        guard ["running", "needs_user"].contains(job["status"] as? String ?? "") else {
            throw Self.failure("cancelled", "Task is no longer running")
        }
    }

    func record(_ context: GuguHostContext, event: [String: Any], messages: [[String: Any]]?) throws {
        try lock.lock(); defer { lock.unlock() }
        try checkActive(context)
        try updateJob(context.jobId) { job in
            var events = job["events"] as? [[String: Any]] ?? []
            events.append(event)
            job["events"] = events
            if let messages { job["messages"] = messages }
        }
    }

    func finish(_ context: GuguHostContext, result: [String: Any]) throws {
        try validate(context)
        try updateJob(context.jobId) { job in
            guard let binding = job["context"] as? [String: Any], try Self.context(binding) == context else {
                throw Self.failure("stale_context", "Cannot finish a different task turn")
            }
            if job["status"] as? String != "cancelled" {
                job["status"] = result["status"]
                job["text"] = result["text"] ?? ""
                job["error"] = result["error"]
                job["messages"] = result["messages"] ?? job["messages"]
            }
        }
    }

    func cancel(_ context: GuguHostContext) throws {
        try lock.lock(); defer { lock.unlock() }
        try checkActive(context)
        try update { next in
            var jobs = next["jobs"] as? [String: [String: Any]] ?? [:]
            var job = jobs[context.jobId]!
            job["status"] = "cancelled"
            jobs[context.jobId] = job
            next["jobs"] = jobs
            var calls = next["calls"] as? [String: [String: Any]] ?? [:]
            for (id, var call) in calls where call["jobId"] as? String == context.jobId {
                if call["status"] as? String == "executing", call["mutationClaimed"] as? Bool == true {
                    call["status"] = "execution_unknown"
                } else if ["admitted", "approved", "needs_confirmation", "executing"].contains(call["status"] as? String ?? "") {
                    call["status"] = "cancelled"
                }
                calls[id] = call
            }
            next["calls"] = calls
        }
    }

    func admitTool(_ context: GuguHostContext, toolCallId: String, action: String,
                   arguments: [String: Any], deadlineAtMs: Int64) throws -> (GuguNativeToolRequest, [String: Any]?) {
        try lock.lock(); defer { lock.unlock() }
        try checkActive(context)
        guard ["calendar.events.list", "calendar.events.create", "calendar.events.update", "calendar.events.delete"].contains(action), !toolCallId.isEmpty else {
            throw Self.failure("invalid_args", "Unsupported native tool or missing tool-call ID")
        }
        try updateJob(context.jobId) { $0["usedCalendar"] = true }
        let binding = try Self.object(context)
        let requestId = try Self.digest(["context": binding, "toolCallId": toolCallId])
        let argumentsJSON = try GuguJavaScriptRuntime.json(arguments)
        let digest = SHA256.hash(data: Data(argumentsJSON.utf8)).map { String(format: "%02x", $0) }.joined()
        let request = GuguNativeToolRequest(context: context, requestId: requestId, toolCallId: toolCallId,
            actionName: action, argumentsJSON: argumentsJSON, argumentsSHA256: digest, deadlineAtMs: deadlineAtMs)
        let saved = try update { next -> [String: Any]? in
            var calls = next["calls"] as? [String: [String: Any]] ?? [:]
            if let existing = calls[requestId] {
                guard existing["argumentsSHA256"] as? String == digest, existing["actionName"] as? String == action else { throw Self.failure("duplicate_conflict", "Tool-call ID has different action or arguments") }
                return existing
            }
            calls[requestId] = ["context": binding, "jobId": context.jobId, "requestId": requestId,
                "toolCallId": toolCallId, "actionName": action, "argumentsJSON": argumentsJSON,
                "argumentsSHA256": digest, "deadlineAtMs": deadlineAtMs,
                "status": action == "calendar.events.list" ? "admitted" : "needs_confirmation", "mutationClaimed": false]
            next["calls"] = calls
            return nil
        }
        if action != "calendar.events.list", saved == nil { try updateJob(context.jobId) { $0["status"] = "needs_user" } }
        return (request, saved)
    }

    func approve(_ request: GuguNativeToolRequest) throws {
        try lock.lock(); defer { lock.unlock() }
        try checkActive(request.context)
        try checkDeadline(request)
        try updateCall(request.requestId) { call in
            guard call["status"] as? String == "needs_confirmation" else { throw Self.failure("duplicate_conflict", "Approval is no longer pending") }
            guard call["argumentsSHA256"] as? String == request.argumentsSHA256,
                  call["actionName"] as? String == request.actionName else { throw Self.failure("duplicate_conflict", "Approved parameters changed") }
            call["status"] = "approved"
            call["approvedBy"] = request.context.ownerId
            call["approvedAtMs"] = Int64(Date().timeIntervalSince1970 * 1000)
            call["approvedArgumentsSHA256"] = request.argumentsSHA256
        }
        try updateJob(request.context.jobId) { $0["status"] = "running" }
    }

    func beginMutation(_ request: GuguNativeToolRequest) throws {
        try lock.lock(); defer { lock.unlock() }
        try checkActive(request.context)
        try checkDeadline(request)
        try updateCall(request.requestId) { call in
            guard call["status"] as? String == "approved", call["mutationClaimed"] as? Bool == false,
                  call["argumentsSHA256"] as? String == request.argumentsSHA256,
                  call["actionName"] as? String == request.actionName else {
                throw Self.failure("not_granted", "Exact one-use native approval is missing or consumed")
            }
            call["status"] = "executing"
            call["mutationClaimed"] = true
        }
    }

    func finishMutation(_ request: GuguNativeToolRequest, result: [String: Any]) throws {
        // Deliberately does not check active permissions: preserve an already-known
        // OS outcome even if its sensitive payload can no longer be delivered.
        try updateCall(request.requestId) { call in
            guard call["mutationClaimed"] as? Bool == true,
                  ["executing", "execution_unknown"].contains(call["status"] as? String ?? ""),
                  call["argumentsSHA256"] as? String == request.argumentsSHA256,
                  call["actionName"] as? String == request.actionName else {
                throw Self.failure("duplicate_conflict", "Mutation receipt has no matching claim")
            }
            call["status"] = "completed"
            call["receipt"] = ["ok": true, "data": result]
        }
    }

    func completeTool(_ request: GuguNativeToolRequest, result: [String: Any]) throws -> [String: Any] {
        try updateCall(request.requestId) { call in
            if call["mutationClaimed"] as? Bool == true {
                if call["status"] as? String != "completed" {
                    call["status"] = "execution_unknown"
                    return Self.failure("execution_unknown", "OS write was claimed but has no durable receipt").envelope
                }
                return result
            }
            call["status"] = "completed"
            call["receipt"] = result
            return result
        }
    }

    func job(_ id: String) throws -> [String: Any] {
        try lock.lock(); defer { lock.unlock() }
        state = try readLatest()
        guard let job = (state["jobs"] as? [String: [String: Any]])?[id] else { throw Self.failure("invalid_args", "Unknown task") }
        return job
    }

    /// A timeline may not infer admission order from dictionary iteration, UUIDs
    /// or summaries. Pre-ordering prototype journals fail explicitly if ambiguous.
    func jobs(in context: GuguHostContext) throws -> [[String: Any]] {
        try validate(context)
        try lock.lock(); defer { lock.unlock() }
        state = try readLatest()
        let jobs = state["jobs"] as? [String: [String: Any]] ?? [:]
        let matching = try jobs.values.filter { job in
            guard let raw = job["context"] as? [String: Any] else { throw Self.failure("invalid_journal", "Task binding is missing") }
            let saved = try Self.context(raw)
            return saved.ownerId == context.ownerId && saved.installationId == context.installationId &&
                saved.agentUserId == context.agentUserId && saved.sessionId == context.sessionId && saved.contextEpoch == context.contextEpoch
        }
        if matching.count <= 1 { return Array(matching) }
        let sequence = matching.compactMap { $0["admissionSequence"] as? Int }
        guard sequence.count == matching.count, Set(sequence).count == sequence.count else {
            throw Self.failure("record_unreadable", "Task admission order is missing or ambiguous")
        }
        return matching.sorted { ($0["admissionSequence"] as! Int) < ($1["admissionSequence"] as! Int) }
    }

    func invalidateCalendarContexts() throws -> [GuguHostContext] {
        try update { next in
            var jobs = next["jobs"] as? [String: [String: Any]] ?? [:]
            var affected: [GuguHostContext] = []
            for (id, var job) in jobs where job["usedCalendar"] as? Bool == true {
                job["contextInvalidated"] = true
                if ["running", "needs_user"].contains(job["status"] as? String ?? "") {
                    job["status"] = "cancelled"
                    if let raw = job["context"] as? [String: Any] { affected.append(try Self.context(raw)) }
                }
                jobs[id] = job
            }
            var calls = next["calls"] as? [String: [String: Any]] ?? [:]
            for (id, var call) in calls where jobs[call["jobId"] as? String ?? ""]?["contextInvalidated"] as? Bool == true {
                if call["status"] as? String == "executing", call["mutationClaimed"] as? Bool == true { call["status"] = "execution_unknown" }
                else if ["admitted", "executing", "needs_confirmation", "approved"].contains(call["status"] as? String ?? "") { call["status"] = "cancelled" }
                calls[id] = call
            }
            next["jobs"] = jobs
            next["calls"] = calls
            return affected
        }
    }

    /// Reconstruct only missing results from actual native receipts. An absent
    /// receipt is explicitly unknown/interrupted, never a claim that a write failed.
    /// These are native recovery records, not fabricated Pi stream events.
    func continuationTranscript(jobId: String) throws -> [[String: Any]] {
        try lock.lock(); defer { lock.unlock() }
        let job = try self.job(jobId)
        let messages = job["messages"] as? [[String: Any]] ?? []
        let calls = (state["calls"] as? [String: [String: Any]] ?? [:]).values.filter { $0["jobId"] as? String == jobId }
        var result: [[String: Any]] = []
        for (index, message) in messages.enumerated() {
            result.append(message)
            guard message["role"] as? String == "assistant" else { continue }
            let toolCalls = (message["content"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "toolCall" }
            for tool in toolCalls {
                guard let callId = tool["id"] as? String, let name = tool["name"] as? String else { throw Self.failure("invalid_journal", "Saved tool call is malformed") }
                let following = messages.dropFirst(index + 1).prefix(while: { $0["role"] as? String == "toolResult" })
                if following.contains(where: { $0["toolCallId"] as? String == callId }) { continue }
                let call = calls.first(where: { $0["toolCallId"] as? String == callId })
                let receipt = call?["receipt"] as? [String: Any]
                let recovered = receipt ?? Self.failure(call?["mutationClaimed"] as? Bool == true ? "execution_unknown" : "interrupted",
                    "Previous process stopped before a confirmed result. Do not automatically repeat a device write.").envelope
                result.append(["role": "toolResult", "toolCallId": callId, "toolName": name,
                    "content": [["type": "text", "text": try GuguJavaScriptRuntime.json(recovered)]],
                    "isError": recovered["ok"] as? Bool != true, "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
                    "details": ["source": "native_journal_recovery", "requestId": call?["requestId"] ?? NSNull()]])
            }
        }
        return result
    }

    func calls(jobId: String) throws -> [[String: Any]] {
        try lock.lock(); defer { lock.unlock() }
        state = try readLatest()
        return (state["calls"] as? [String: [String: Any]] ?? [:]).values.filter { $0["jobId"] as? String == jobId }
    }

    func activeContexts(runtimeInstanceId: String) throws -> [GuguHostContext] {
        try lock.lock(); defer { lock.unlock() }
        state = try readLatest()
        let jobs = state["jobs"] as? [String: [String: Any]] ?? [:]
        return try jobs.values.compactMap { job in
            guard ["running", "needs_user"].contains(job["status"] as? String ?? ""), let raw = job["context"] as? [String: Any] else { return nil }
            let context = try Self.context(raw)
            return context.runtimeInstanceId == runtimeInstanceId ? context : nil
        }
    }

    /// Owner retirement also covers admitted disk tasks without a live runtime.
    /// Claimed mutations remain unknown until their real late receipt is recorded.
    func cancelAllTasks() throws {
        try update { next in
            var jobs = next["jobs"] as? [String: [String: Any]] ?? [:]
            for (id, var job) in jobs where ["running", "needs_user", "queued"].contains(job["status"] as? String ?? "") {
                job["status"] = "cancelled"; jobs[id] = job
            }
            var calls = next["calls"] as? [String: [String: Any]] ?? [:]
            for (id, var call) in calls {
                if call["status"] as? String == "executing", call["mutationClaimed"] as? Bool == true {
                    call["status"] = "execution_unknown"
                } else if ["admitted", "approved", "needs_confirmation", "executing"].contains(call["status"] as? String ?? "") {
                    call["status"] = "cancelled"
                }
                calls[id] = call
            }
            next["jobs"] = jobs; next["calls"] = calls
        }
    }

    func checkDeadline(_ request: GuguNativeToolRequest) throws {
        if Int64(Date().timeIntervalSince1970 * 1000) >= request.deadlineAtMs { throw Self.failure("expired", "Native operation has expired") }
    }

    private func validate(_ context: GuguHostContext) throws {
        let ids = [context.ownerId, context.installationId, context.agentUserId, context.sessionId, context.jobId, context.contextEpoch, context.runtimeInstanceId]
        guard ids.allSatisfy({ UUID(uuidString: $0) != nil }), context.ownerId == ownerId, context.installationId == installationId else {
            throw Self.failure("stale_context", "Native owner or installation binding mismatch")
        }
    }

    private func updateJob<T>(_ id: String, _ body: (inout [String: Any]) throws -> T) throws -> T {
        try update { next in
            var jobs = next["jobs"] as? [String: [String: Any]] ?? [:]
            guard var job = jobs[id] else { throw Self.failure("invalid_args", "Unknown task") }
            let result = try body(&job)
            jobs[id] = job
            next["jobs"] = jobs
            return result
        }
    }

    private func updateCall<T>(_ id: String, _ body: (inout [String: Any]) throws -> T) throws -> T {
        try update { next in
            var calls = next["calls"] as? [String: [String: Any]] ?? [:]
            guard var call = calls[id] else { throw Self.failure("invalid_args", "Unknown native call") }
            let result = try body(&call)
            calls[id] = call
            next["calls"] = calls
            return result
        }
    }

    private func update<T>(_ body: (inout [String: Any]) throws -> T) throws -> T {
        try lock.lock(); defer { lock.unlock() }
        state = try readLatest()
        var next = state
        let result = try body(&next)
        try persist(next)
        state = next
        return result
    }

    /// Called only with the shared transaction lock held. Missing/corrupt files
    /// fail closed; an existing handle must never recreate an empty journal.
    private func readLatest() throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        guard let saved = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              saved["version"] as? Int == 1, saved["ownerId"] as? String == ownerId,
              saved["installationId"] as? String == installationId else {
            throw Self.failure("stale_context", "Journal owner, installation or version mismatch")
        }
        return saved
    }

    private func persist(_ next: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: next, options: [.sortedKeys])
        #if os(iOS)
        try bytes.write(to: url, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let file = try FileHandle(forWritingTo: url)
        try file.synchronize()
        try file.close()
    }

    static func object(_ context: GuguHostContext) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(context)) as! [String: Any]
    }
    static func context(_ object: [String: Any]) throws -> GuguHostContext {
        try JSONDecoder().decode(GuguHostContext.self, from: JSONSerialization.data(withJSONObject: object))
    }
    static func digest(_ value: [String: Any]) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    private static func failure(_ code: String, _ message: String) -> GuguHostFailure { GuguHostFailure(code: code, message: message) }
}
