#if DEBUG && os(iOS) && targetEnvironment(simulator)
import XCTest
import Foundation
import CryptoKit
@testable import App

private func loopRequire(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw GuguHostFailure(code: "loop_fixture_failed", message: message) }
}
private func loopWait<T>(_ work: (@escaping (T) -> Void) -> Void) throws -> T {
    let signal = DispatchSemaphore(value: 0); var value: T?
    work { value = $0; signal.signal() }
    try loopRequire(signal.wait(timeout: .now() + 15) == .success, "Native loop callback timed out")
    return try XCTUnwrap(value)
}
private final class LoopCalendar: GuguNativeToolExecutor {
    var writes = 0
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        do {
            try control.checkActive(); try control.beginMutation(); writes += 1
            let receipt: [String: Any] = ["event_id": "synthetic-one-use-event"]
            try control.finishMutation(receipt); completion(["ok": true, "data": receipt])
        } catch { completion((error as? GuguHostFailure ?? .init(code: "fixture", message: "Synthetic calendar failed")).envelope) }
    }
}
private final class LoopModel: GuguModelCompleting {
    unowned let fixture: LoopFixture
    init(_ fixture: LoopFixture) { self.fixture = fixture }
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        fixture.lock.lock(); defer { fixture.lock.unlock() }
        fixture.modelCalls[context.agentUserId, default: 0] += 1
        fixture.toolNames = (body["tools"] as? [[String: Any]] ?? []).compactMap { ($0["function"] as? [String: Any])?["name"] as? String }
        let hasTool = (body["messages"] as? [[String: Any]] ?? []).contains { $0["role"] as? String == "tool" }
        var message: [String: Any] = ["role": "assistant", "content": "Synthetic result for \(context.agentUserId)"]
        if fixture.toolMode != "none", !hasTool {
            let calendar = fixture.toolMode == "calendar"
            let args: [String: Any] = calendar ? ["title": "Synthetic fixture only", "start": "2026-11-15T10:00:00+08:00"]
                : ["chat_id": fixture.chat, "text": "Explicit synthetic reply", "to_user_ids": ["user:\(fixture.sender)"], "reply_to_message_id": "msg:\(fixture.source)"]
            let json = try! JSONSerialization.data(withJSONObject: args)
            message = ["role": "assistant", "content": NSNull(), "tool_calls": [["id": "synthetic-exact-tool-call", "type": "function",
                "function": ["name": calendar ? "calendar_create" : "message_send", "arguments": String(decoding: json, as: UTF8.self)]]]]
        }
        completion(["ok": true, "data": ["choices": [["finish_reason": message["tool_calls"] == nil ? "stop" : "tool_calls", "message": message]]]])
    }
    func cancel(id: String) {}
}
private final class LoopFixture {
    let root: URL, binding: GuguIOSHostBinding, store: GuguIOSBackendStore, lifecycle: GuguIOSHostLifecycle, packaged: GuguPackagedRuntime
    let agentA = UUID().uuidString.lowercased(), agentB = UUID().uuidString.lowercased()
    let chat = UUID().uuidString.lowercased(), sender = UUID().uuidString.lowercased(), source = UUID().uuidString.lowercased()
    let rules = "Preserve original source and recipient privacy."
    let lock = NSRecursiveLock(), changed = DispatchSemaphore(value: 0), calendar = LoopCalendar()
    var allowed = true, loseReadACK = false, loseSendACK = false, toolMode = "none"
    var command: [String: Any]?, commandLeaseValid = true
    var pending: Set<String>, modelCalls: [String: Int] = [:], toolNames: [String] = [], ackAgents: [String] = [], sent: [[String: Any]] = [], effects: Set<String> = []
    var schedulerStorage: GuguIOSTaskScheduler?
    init(root: URL, asset: Data) throws {
        self.root = root
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        binding = .init(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        pending = []
        store = try .init(root: root.appendingPathComponent("backend"), binding: binding)
        let bound = binding
        lifecycle = .init(root: root.appendingPathComponent("journal"), verifiedIdentity: { bound })
        packaged = .init(asset: asset, sha256: SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined(), piVersion: "1.4.0")
        for id in [agentA, agentB] {
            _ = try store.admit("agents", id: id, fingerprint: id) {
                ["ownerId": owner, "deviceId": binding.deviceId, "agentUserId": id,
                 "sessionId": UUID().uuidString.lowercased(), "contextEpoch": UUID().uuidString.lowercased(),
                 "modelId": "synthetic-catalog", "displayName": "Synthetic Agent", "status": "idle", "chatId": chat]
            }
        }
        pending = [agentA, agentB]
    }
    func check() throws { try loopRequire(allowed, "Synthetic native owner retired") }
    func agent(_ id: String) throws -> [String: Any] { try XCTUnwrap(store.record("agents", id: id)) }
    var row: [String: Any] {
        ["id": source, "chat_id": chat, "chat_kind": "group", "chat_public_id": 1234, "chat_name": "Synthetic room", "seq": 7,
         "content": "Read the synthetic calendar task and return its result", "content_type": "text", "sender_user_id": sender,
         "sender_type": "human", "sender_display_name": "Synthetic sender", "sender_gugu_number": NSNull(),
         "to_user_ids": [agentA, agentB], "is_whisper": false, "listen_mode": "passive", "created_at": "2026-11-15T00:00:00Z",
         "file_item_id": NSNull(), "file_version": NSNull(), "file_blob_id": NSNull(), "group_rules": rules,
         "named_identities": [agentA: ["display_name": "A", "type": "agent"], agentB: ["display_name": "B", "type": "agent"]]]
    }
    lazy var broker: GuguIOSCloudBroker = try! .init(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
        try self.check(); try loopRequire(expected == self.binding, "Wrong synthetic binding")
        return .init(binding: expected, accessToken: "synthetic-human-never-journaled", expiresAt: Date().addingTimeInterval(3600))
    }, send: { request, done in
        self.lock.lock(); defer { self.lock.unlock() }
        do {
            let name = request.url!.lastPathComponent
            let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            var result: Any = NSNull()
            switch name {
            case "gugu_device_commands":
                var command = try XCTUnwrap(self.command)
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
                try loopRequire(query.first { $0.name == "id" }?.value == "eq.\(command["id"]!)", "Command changed its original ID")
                if request.httpMethod == "PATCH" {
                    if body["status"] as? String == "done" {
                        try loopRequire(query.first { $0.name == "claim_token" }?.value == "eq.\(command["claim_token"]!)", "Settlement changed the original claim")
                        try loopRequire(!self.pending.contains(self.agentA), "Command settled before exact-source ACK")
                    }
                    for (key, value) in body { command[key] = value }; self.command = command
                }
                result = [command]
            case "recheck_device_command_execution": result = self.commandLeaseValid
            case "active_users":
                let raw = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "id" }!.value!
                let id = String(raw.dropFirst(3))
                result = [["id": id, "type": "agent", "owner_user_id": self.binding.ownerId, "device_id": self.binding.deviceId]]
            case "list_member_ids": result = [["user_id": self.agentA], ["user_id": self.agentB], ["user_id": self.sender]]
            case "chat_facts": result = [["id": self.chat, "kind": "group", "group_prompt": self.rules]]
            case "pull_agent_inbox_v2": result = self.pending.contains(body["p_agent_user_id"] as? String ?? "") ? [self.row] : []
            case "mark_read_on_deliver":
                let id = body["p_user_id"] as! String, source = body["p_message_id"] as! String
                try loopRequire(source == self.source, "ACK replaced the original source UUID")
                let jobID = try self.store.inboxJobID(agentId: id, sourceMessageId: source)
                let input = try self.store.record("inputs", id: jobID)
                try loopRequire(input?["agentId"] as? String == id && (input?["route"] as? [String: Any])?["sourceMessageId"] as? String == source, "ACK ran without this recipient's durable source custody")
                self.ackAgents.append(id)
                if self.loseReadACK { self.loseReadACK = false; done(nil, nil, URLError(.networkConnectionLost)); return }
                self.pending.remove(id)
            case "send_message_idempotent":
                try loopRequire(body["p_reply_to_message_id"] as? String == self.source, "Chat result replied to a private execution ID")
                self.sent.append(body); let id = body["p_message_id"] as! String; self.effects.insert(id)
                if self.loseSendACK { self.loseSendACK = false; done(nil, nil, URLError(.networkConnectionLost)); return }
                result = [["id": id]]
            case "model-access":
                let action = body["action"] as! String
                if action == "catalog" { result = ["models": [["id": "synthetic-catalog", "display_name": "Synthetic", "enabled": true, "protocols": ["openai-chat-completions"]]]] }
                else if action == "issue" { result = ["session_id": UUID().uuidString.lowercased(), "protocol": "openai-chat-completions", "relay_url": "https://synthetic-model.invalid", "token": "synthetic-short-never-journaled", "model": "synthetic-wire", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))] }
                else { result = ["ok": true] }
            default: throw GuguHostFailure(code: "fixture", message: "Unexpected native loop cloud request: \(name)")
            }
            done(try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
        } catch { done(nil, nil, error) }
    })
    lazy var sources = GuguIOSSourceAccess(store: store, broker: broker, check: check)
    lazy var projection = try! GuguJavaScriptRuntime(asset: packaged.asset, expectedSHA256: packaged.sha256,
        request: { _, done in done(["ok": false, "code": "fixture", "message": "Projection cannot execute a task"]) }, cancel: { _ in }, event: { _ in })
    func scheduler() throws -> GuguIOSTaskScheduler {
        if let schedulerStorage { return schedulerStorage }
        let scheduler = try GuguIOSTaskScheduler.open(store: store, lifecycle: lifecycle, runtime: packaged, broker: broker, check: check,
            executor: { self.calendar }, changed: { self.changed.signal() }, sourceAuthorization: { self.sources.authorize($0, completion: $1) },
            modelTransport: { _ in LoopModel(self) })
        schedulerStorage = scheduler; return scheduler
    }
    func pump() throws -> GuguIOSInboxPump { .init(store: store, broker: broker, sources: sources, runtime: projection, scheduler: try scheduler(), check: check) }
    func pull(_ pump: GuguIOSInboxPump, _ id: String) throws -> Result<Int, Error> { try loopWait { pump.pull(agentId: id, completion: $0) } }
    func wait(_ id: String, key: String = "replyStatus", equals: String) throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if try store.record("inputs", id: id)?[key] as? String == equals { return }
            _ = changed.wait(timeout: .now() + 0.05)
        }
        throw GuguHostFailure(code: "fixture_timeout", message: "Native input did not reach expected \(key)=\(equals)")
    }
    func seedLegacy(_ status: String) throws {
        let a = try agent(agentA)
        let identity: [String: Any] = ["kind": "inbox", "agentId": agentA, "sessionId": a["sessionId"]!, "contextEpoch": a["contextEpoch"]!, "sourceMessageId": source, "chatId": chat]
        _ = try store.admit("inputs", id: source, fingerprint: GuguHostJournal.digest(identity)) {
            ["id": source, "agentId": agentA, "sessionId": a["sessionId"]!, "contextEpoch": a["contextEpoch"]!, "status": status,
             "prompt": "Original legacy input must stay unchanged", "sequence": 1,
             "route": ["kind": "chat", "chatId": chat, "sourceMessageId": source, "senderUserId": sender, "whisper": false]]
        }
        try store.transaction { $0["nextInputSequence"] = 1 }
    }
    func stop() throws {
        if let schedulerStorage { let result: Result<Void, Error> = try loopWait { schedulerStorage.stop(completion: $0) }; try result.get() }
    }
}

final class IOSHostLoopTests: XCTestCase {
    private var root: URL!
    private var fixtures: [LoopFixture] = []
    override func setUpWithError() throws {
        try super.setUpWithError()
        let env = ProcessInfo.processInfo.environment
        try loopRequire(Bundle.main.bundleIdentifier == "app.gugu.chat", "Actual App must host these tests")
        let expected = try XCTUnwrap(env["GUGU_D_EXPECTED_SIMULATOR_UDID"])
        try loopRequire(env["SIMULATOR_UDID"]?.lowercased() == expected.lowercased(), "Tests must use the parent's owned simulator")
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("IOSHostLoopFixtures", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws {
        for fixture in fixtures { try fixture.stop() }; fixtures.removeAll()
        if let root { try FileManager.default.removeItem(at: root) }
        try super.tearDownWithError()
    }
    private func fixture(_ name: String) throws -> LoopFixture {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "agent", withExtension: "js", subdirectory: "HostRuntime"))
        let fixture = try LoopFixture(root: root.appendingPathComponent(name), asset: Data(contentsOf: url))
        fixtures.append(fixture); return fixture
    }
    func testTwoRecipientsLostReadACKAndIndependentReplies() throws {
        let f = try fixture("two-targets"), pump = try f.pump(); f.loseReadACK = true
        guard case .failure = try f.pull(pump, f.agentA) else { return XCTFail("Synthetic read ACK was not lost") }
        let a = try f.store.inboxJobID(agentId: f.agentA, sourceMessageId: f.source)
        try f.wait(a, equals: "settled")
        _ = try f.pull(pump, f.agentB).get()
        let b = try f.store.inboxJobID(agentId: f.agentB, sourceMessageId: f.source); try f.wait(b, equals: "settled")
        _ = try f.pull(pump, f.agentA).get()
        XCTAssertNotEqual(a, b); XCTAssertNotEqual(a, f.source); XCTAssertNotEqual(b, f.source)
        XCTAssertEqual(f.modelCalls[f.agentA], 1); XCTAssertEqual(f.modelCalls[f.agentB], 1)
        XCTAssertEqual(f.effects.count, 2); XCTAssertEqual(f.sent.count, 2)
        XCTAssertEqual(f.ackAgents.filter { $0 == f.agentA }.count, 2)
        XCTAssertEqual(f.pending, [])
        for id in [a, b] { XCTAssertEqual((try f.store.record("inputs", id: id)?["route"] as? [String: Any])?["sourceMessageId"] as? String, f.source) }
    }
    func testColdLegacyCompletedAndUnknownInputsNeverReplay() throws {
        for status in ["done", "running", "execution_unknown"] {
            let f = try fixture("legacy-" + status); try f.seedLegacy(status)
            // Fresh native scheduler/store reconstruction sees only durable records.
            let reopened = try GuguIOSBackendStore(root: f.root.appendingPathComponent("backend"), binding: f.binding)
            XCTAssertEqual(try reopened.inboxJobID(agentId: f.agentA, sourceMessageId: f.source), f.source)
            let pump = try f.pump(); _ = try f.pull(pump, f.agentA).get(); _ = try f.pull(pump, f.agentB).get()
            let b = try f.store.inboxJobID(agentId: f.agentB, sourceMessageId: f.source); try f.wait(b, equals: "settled")
            XCTAssertNil(f.modelCalls[f.agentA]); XCTAssertEqual(f.modelCalls[f.agentB], 1)
            XCTAssertEqual(try reopened.record("inputs", id: f.source)?["status"] as? String, status == "running" ? "interrupted" : status)
            XCTAssertEqual(try reopened.record("inputs", id: f.source)?["prompt"] as? String, "Original legacy input must stay unchanged")
            XCTAssertEqual(f.effects.count, 1)
        }
    }
    func testFailedDiskAdmissionNeverAcknowledgesOrExecutes() throws {
        let f = try fixture("disk-admission"), pump = try f.pump()
        let directory = f.root.appendingPathComponent("backend").appendingPathComponent(f.binding.ownerId)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
        guard case .failure = try f.pull(pump, f.agentA) else { return XCTFail("Read-only directory accepted a durable input") }
        XCTAssertTrue(f.ackAgents.isEmpty); XCTAssertTrue(f.modelCalls.isEmpty)
        XCTAssertTrue((try f.store.snapshot()["inputs"] as? [String: Any])?.isEmpty == true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        _ = try f.pull(pump, f.agentA).get()
        let id = try f.store.inboxJobID(agentId: f.agentA, sourceMessageId: f.source); try f.wait(id, equals: "settled")
        XCTAssertEqual(f.modelCalls[f.agentA], 1); XCTAssertEqual(f.effects.count, 1)
    }
    func testPiCommunicationToolsAndFinalAnswerShareOneOutbox() throws {
        let f = try fixture("communication"); f.toolMode = "message"
        _ = try f.pull(f.pump(), f.agentA).get()
        let id = try f.store.inboxJobID(agentId: f.agentA, sourceMessageId: f.source); try f.wait(id, equals: "settled")
        XCTAssertTrue(Set(["profile_whoami", "message_conversations", "message_rules", "message_members", "message_history", "message_send"]).isSubset(of: Set(f.toolNames)))
        XCTAssertEqual(f.modelCalls[f.agentA], 2); XCTAssertEqual(f.effects.count, 1); XCTAssertEqual(f.sent.count, 1)
        let saved = String(decoding: try JSONSerialization.data(withJSONObject: f.store.snapshot()), as: UTF8.self)
        XCTAssertFalse(saved.contains("synthetic-human-never-journaled")); XCTAssertFalse(saved.contains("synthetic-short-never-journaled"))
    }
    func testCalendarApprovalThenResultReturnsToOriginalChat() throws {
        let f = try fixture("calendar-loop"); f.toolMode = "calendar"
        let scheduler = try f.scheduler(); _ = try f.pull(f.pump(), f.agentA).get()
        let id = try f.store.inboxJobID(agentId: f.agentA, sourceMessageId: f.source); try f.wait(id, key: "status", equals: "needs_user")
        XCTAssertEqual(f.calendar.writes, 0)
        let timeline: [String: Any] = try loopWait { scheduler.timeline(agent: try! f.agent(f.agentA), method: "snapshot", input: [:], completion: $0) }
        let data = try XCTUnwrap(timeline["data"] as? [String: Any])
        let pending = try XCTUnwrap((data["settlements"] as? [[String: Any]])?.first { $0["state"] as? String == "pending" })
        let item = try XCTUnwrap(pending["itemId"] as? String)
        let approved: Result<[String: Any], Error> = try loopWait { scheduler.respond(agent: try! f.agent(f.agentA), requestId: item, option: "approve", completion: $0) }
        _ = try approved.get(); try f.wait(id, equals: "settled")
        XCTAssertEqual(f.calendar.writes, 1); XCTAssertEqual(f.modelCalls[f.agentA], 2); XCTAssertEqual(f.effects.count, 1)
        let repeated: Result<[String: Any], Error> = try loopWait { scheduler.respond(agent: try! f.agent(f.agentA), requestId: item, option: "approve", completion: $0) }
        XCTAssertEqual(try repeated.get()["accepted"] as? Bool, false); XCTAssertEqual(f.calendar.writes, 1)
    }
    func testCrossAgentDerivedIDConflictNeverAcknowledges() throws {
        let f = try fixture("cross-agent"), id = try f.store.inboxJobID(agentId: f.agentB, sourceMessageId: f.source)
        _ = try f.store.admit("inputs", id: id, fingerprint: "another-agent") { ["id": id, "agentId": f.agentA, "status": "execution_unknown"] }
        let pump = try f.pump(), before = try GuguHostJournal.digest(f.store.snapshot())
        guard case .failure = try f.pull(pump, f.agentB) else { return XCTFail("Another Agent's execution ID was accepted") }
        XCTAssertEqual(try GuguHostJournal.digest(f.store.snapshot()), before)
        XCTAssertTrue(f.ackAgents.isEmpty); XCTAssertTrue(f.modelCalls.isEmpty)
    }
    func testOriginalWakeClaimRecheckAndSettlementUseOnlyAuthoritativeInbox() throws {
        let f = try fixture("delivery-command"), pump = try f.pump(), commandID = UUID().uuidString.lowercased()
        f.command = ["id": commandID, "device_id": f.binding.deviceId, "type": "agent.deliver", "status": "pending",
            "payload": ["agent_user_id": f.agentA, "content": "UNTRUSTED_COMMAND_BODY_MUST_NEVER_EXECUTE"]]
        let adapter = GuguIOSDeliveryCommand(store: f.store, broker: f.broker, pump: pump,
            instanceId: UUID().uuidString.lowercased(), check: f.check)
        f.commandLeaseValid = false
        let expired: Result<Void, Error> = try loopWait { adapter.execute(id: commandID, completion: $0) }
        guard case .failure = expired else { return XCTFail("Expired claim admitted the inbox") }
        XCTAssertTrue(f.ackAgents.isEmpty); XCTAssertTrue(f.modelCalls.isEmpty)
        f.commandLeaseValid = true
        let completed: Result<Void, Error> = try loopWait { adapter.execute(id: commandID, completion: $0) }; try completed.get()
        let jobID = try f.store.inboxJobID(agentId: f.agentA, sourceMessageId: f.source); try f.wait(jobID, equals: "settled")
        XCTAssertEqual(f.command?["status"] as? String, "done")
        XCTAssertEqual(try f.store.record("requests", id: "command:\(commandID)")?["status"] as? String, "completed")
        XCTAssertFalse((try f.store.record("inputs", id: jobID)?["prompt"] as? String ?? "").contains("UNTRUSTED_COMMAND_BODY"))
        let replay: Result<Void, Error> = try loopWait { adapter.execute(id: commandID, completion: $0) }; try replay.get()
        XCTAssertEqual(f.modelCalls[f.agentA], 1); XCTAssertEqual(f.effects.count, 1)
    }
    func testLostResultACKAndColdReopenNeverSendOrExecuteAgain() throws {
        let f = try fixture("lost-result"); f.loseSendACK = true
        _ = try f.pull(f.pump(), f.agentA).get()
        let id = try f.store.inboxJobID(agentId: f.agentA, sourceMessageId: f.source); try f.wait(id, equals: "uncertain")
        XCTAssertEqual(f.effects.count, 1); XCTAssertEqual(f.modelCalls[f.agentA], 1)
        try f.stop(); f.schedulerStorage = nil; try f.lifecycle.activate(binding: f.binding)
        let reopened = try GuguIOSBackendStore(root: f.root.appendingPathComponent("backend"), binding: f.binding)
        XCTAssertEqual(try reopened.record("inputs", id: id)?["replyStatus"] as? String, "uncertain")
        // The cloud re-pulls an old source after restart; native custody wins.
        f.pending.insert(f.agentA); _ = try f.pull(f.pump(), f.agentA).get()
        XCTAssertEqual(f.sent.count, 1); XCTAssertEqual(f.effects.count, 1); XCTAssertEqual(f.modelCalls[f.agentA], 1)
        XCTAssertEqual(try reopened.record("inputs", id: id)?["replyStatus"] as? String, "uncertain")
    }
}
#endif
