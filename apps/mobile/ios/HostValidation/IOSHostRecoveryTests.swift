#if DEBUG && os(iOS) && targetEnvironment(simulator)
import XCTest
import Foundation
import CryptoKit
@testable import App

private final class RecoverySocket: GuguIOSRealtimeSocket {
    private let lock = NSLock()
    private var queued: [String] = []
    private var receiver: ((Result<String, Error>) -> Void)?
    func resume() {}
    func send(_ text: String, completion: @escaping (Error?) -> Void) {
        let frame = try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        completion(nil)
        let reply: [String: Any] = ["topic": frame["topic"]!, "event": "phx_reply", "ref": frame["ref"]!,
            "join_ref": frame["join_ref"] ?? NSNull(), "payload": ["status": "ok", "response": [:]]]
        let value = String(decoding: try! JSONSerialization.data(withJSONObject: reply), as: UTF8.self)
        lock.lock()
        if let receiver { self.receiver = nil; lock.unlock(); receiver(.success(value)) }
        else { queued.append(value); lock.unlock() }
    }
    func receive(completion: @escaping (Result<String, Error>) -> Void) {
        lock.lock()
        if queued.isEmpty { receiver = completion; lock.unlock() }
        else { let value = queued.removeFirst(); lock.unlock(); completion(.success(value)) }
    }
    func close() { lock.lock(); receiver = nil; lock.unlock() }
}
private final class RecoveryCalendar: GuguNativeToolExecutor {
    private(set) var writes = 0
    func validateAccess(_ control: GuguNativeToolControl) throws { try control.checkActive() }
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl, completion: @escaping ([String: Any]) -> Void) {
        do {
            try control.checkActive(); try control.beginMutation(); writes += 1
            try control.finishMutation(["event_id": "synthetic-recovery-event"])
            completion(["ok": true, "data": ["event_id": "synthetic-recovery-event"]])
        } catch { completion((error as? GuguHostFailure ?? .init(code: "fixture", message: "Synthetic write refused")).envelope) }
    }
}
private final class RecoveryModel: GuguModelCompleting {
    unowned let fixture: RecoveryServiceFixture
    init(_ fixture: RecoveryServiceFixture) { self.fixture = fixture }
    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        fixture.lock.lock()
        fixture.modelCalls[context.ownerId, default: 0] += 1
        if fixture.holdOwners.contains(context.ownerId) {
            fixture.heldModels[context.ownerId] = completion; fixture.lock.unlock(); fixture.modelStarted.signal(); return
        }
        fixture.lock.unlock()
        completion(Self.answer("Synthetic current owner reply"))
    }
    func cancel(id: String) { fixture.lock.lock(); fixture.modelCancellations += 1; fixture.lock.unlock() }
    static func answer(_ text: String) -> [String: Any] {
        ["ok": true, "data": ["choices": [["finish_reason": "stop", "message": ["role": "assistant", "content": text]]]]]
    }
    static var lateWrite: [String: Any] {
        ["ok": true, "data": ["choices": [["finish_reason": "tool_calls", "message": ["role": "assistant", "content": NSNull(),
            "tool_calls": [["id": "late-retired-calendar-write", "type": "function", "function": ["name": "calendar_create",
                "arguments": "{\"title\":\"Retired owner must never write\",\"start\":\"2026-11-15T10:00:00+08:00\"}"]]]]]]]]
    }
}
private final class RecoveryServiceFixture {
    let root: URL, a: GuguIOSHostBinding, b: GuguIOSHostBinding, runtime: GuguPackagedRuntime
    let lock = NSRecursiveLock(), changed = DispatchSemaphore(value: 0), modelStarted = DispatchSemaphore(value: 0), catalogStarted = DispatchSemaphore(value: 0)
    let calendar = RecoveryCalendar()
    var current: GuguIOSHostBinding
    var offline = false, holdCatalog = false
    var devices: [String: [String: Any]] = [:], identities: [String: [String: Any]] = [:]
    var holdOwners: Set<String> = [], modelCalls: [String: Int] = [:], modelCancellations = 0
    var heldModels: [String: ([String: Any]) -> Void] = [:]
    var heldCatalog: (() -> Void)?
    init(root: URL, asset: Data) {
        self.root = root
        let install = UUID().uuidString.lowercased(), ownerA = UUID().uuidString.lowercased(), ownerB = UUID().uuidString.lowercased()
        a = .init(ownerId: ownerA, deviceId: "phone-\(install)-\(ownerA)", installationId: install)
        b = .init(ownerId: ownerB, deviceId: "phone-\(install)-\(ownerB)", installationId: install)
        current = a
        runtime = .init(asset: asset, sha256: SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined(), piVersion: "1.4.0")
    }
    lazy var access = GuguIOSOwnerAccess(root: root.appendingPathComponent("owner"), verifiedIdentity: { self.lock.lock(); defer { self.lock.unlock() }; return self.current },
        requireOwnerUI: {}, calendarHasFullAccess: { false }, revokeCalendarAccess: { _ in })
    lazy var lifecycle = GuguIOSHostLifecycle(root: root.appendingPathComponent("journal"), verifiedIdentity: { self.lock.lock(); defer { self.lock.unlock() }; return self.current })
    lazy var service = try! GuguIOSHostService(root: root.appendingPathComponent("service"), runtime: runtime, lifecycle: lifecycle, ownerAccess: access,
        configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid", anonKey: "public"), credentials: { expected in
            self.lock.lock(); defer { self.lock.unlock() }
            guard expected == self.current else { throw GuguHostFailure(code: "stale_context", message: "Synthetic current owner changed") }
            return .init(binding: expected, accessToken: "synthetic-recovery-native-\(expected.ownerId)", expiresAt: Date().addingTimeInterval(3600))
        }, executor: { _ in self.calendar }, deviceMetadata: { ["label": "Synthetic iPhone", "hostname": "synthetic", "osName": "iOS fixture", "tier": "mobile"] },
        brokerSend: { request, done in
            self.lock.lock(); defer { self.lock.unlock() }
            if self.offline { done(nil, nil, URLError(.notConnectedToInternet)); return }
            do {
                let name = request.url!.lastPathComponent
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems ?? []
                func filter(_ key: String) -> String { String((query.first { $0.name == key }?.value ?? "").dropFirst(3)) }
                let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
                var value: Any = NSNull()
                switch name {
                case "runtime_instance_heartbeat": break
                case "recover_orphaned_device_commands": value = 0
                case "fetch_fair_pending_device_commands", "pull_agent_inbox_v2": value = [Any]()
                case "gugu_devices":
                    if request.httpMethod == "GET" { value = self.devices[filter("device_id")].map { [$0] } ?? [] }
                    else if request.httpMethod == "PATCH" {
                        let id = filter("device_id"); self.devices[id]?["capabilities"] = body["capabilities"]; value = [["device_id": id]]
                    } else { let id = body["device_id"] as! String; self.devices[id] = body; value = [body] }
                case "active_users": value = self.identities[filter("id")].map { [$0] } ?? []
                case "model-access":
                    if body["action"] as? String == "catalog" {
                        value = ["models": [["id": "synthetic-catalog", "display_name": "Synthetic", "enabled": true, "protocols": ["openai-chat-completions"]]]]
                        if self.holdCatalog {
                            self.holdCatalog = false
                            let bytes = try JSONSerialization.data(withJSONObject: value)
                            self.heldCatalog = { done(bytes, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil) }
                            self.catalogStarted.signal(); return
                        }
                    } else if body["action"] as? String == "issue" {
                        value = ["session_id": UUID().uuidString.lowercased(), "protocol": "openai-chat-completions", "relay_url": "https://synthetic-model.invalid",
                            "token": "synthetic-recovery-short-never-persisted", "model": "synthetic-wire", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]
                    } else { value = ["ok": true] }
                default: throw GuguHostFailure(code: "fixture", message: "Unexpected recovery cloud request: \(name)")
                }
                done(try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil), nil)
            } catch { done(nil, nil, error) }
        }, socketFactory: { _ in RecoverySocket() }, modelTransport: { _ in RecoveryModel(self) })
    func observe() { service.observeState { _ in self.changed.signal() } }
    func wire(_ binding: GuguIOSHostBinding) -> [String: Any] { ["ownerId": binding.ownerId, "deviceId": binding.deviceId, "installationId": binding.installationId] }
    func until(_ condition: () throws -> Bool) throws {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline { if try condition() { return }; _ = changed.wait(timeout: .now() + 0.01) }
        throw GuguHostFailure(code: "recovery_timeout", message: "Native recovery fact did not arrive")
    }
    func configure(_ binding: GuguIOSHostBinding) throws {
        let reply: [String: Any] = try loopWait { service.configure(["expectedBinding": wire(binding)], completion: $0) }
        try loopRequire(reply["ownerId"] as? String == binding.ownerId, "Native configure lost its original binding")
        try until { try self.service.backend.state(binding: binding)["ready"] as? Bool == true }
    }
    func call(_ binding: GuguIOSHostBinding, _ channel: String, _ args: [Any], id: String = UUID().uuidString.lowercased()) throws -> [String: Any] {
        try loopWait { service.hostCall(["expectedBinding": wire(binding), "id": id, "channel": channel, "args": args], completion: $0) }
    }
    func stop(_ binding: GuguIOSHostBinding) throws {
        let reply: [String: Any] = try loopWait { service.stopHost(["expectedBinding": wire(binding)], completion: $0) }
        try loopRequire(reply.isEmpty, "Native stop did not settle the original owner")
    }
    func seedAgent(_ binding: GuguIOSHostBinding) throws -> [String: Any] {
        let id = UUID().uuidString.lowercased()
        let row: [String: Any] = ["ownerId": binding.ownerId, "deviceId": binding.deviceId, "agentUserId": id,
            "sessionId": UUID().uuidString.lowercased(), "contextEpoch": UUID().uuidString.lowercased(), "chatId": UUID().uuidString.lowercased(),
            "modelId": "synthetic-catalog", "displayName": "Synthetic recovery Agent", "status": "idle"]
        lock.lock(); identities[id] = ["id": id, "type": "agent", "owner_user_id": binding.ownerId, "device_id": binding.deviceId]; lock.unlock()
        return try service.backend.store!.admit("agents", id: id, fingerprint: id) { row }
    }
    func input(_ binding: GuguIOSHostBinding, _ agent: [String: Any], text: String) throws -> String {
        let reply = try call(binding, "sessionTimeline.sessionSend", [["conversationId": agent["sessionId"]!, "text": text]])
        let id = (reply["result"] as? [String: Any])?["messageId"] as? String
        return try XCTUnwrap(id)
    }
}
final class IOSHostRecoveryTests: XCTestCase {
    private var root: URL!
    private var fixtures: [RecoveryServiceFixture] = []
    override func setUpWithError() throws {
        try super.setUpWithError()
        let env = ProcessInfo.processInfo.environment
        XCTAssertEqual(Bundle.main.bundleIdentifier, "app.gugu.chat")
        XCTAssertEqual(env["SIMULATOR_UDID"]?.lowercased(), try XCTUnwrap(env["GUGU_D_EXPECTED_SIMULATOR_UDID"]).lowercased())
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        root = support.appendingPathComponent("IOSRecoveryFixtures").appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    override func tearDownWithError() throws {
        for f in fixtures { try f.stop(f.current) }
        if let root { try FileManager.default.removeItem(at: root) }
        fixtures.removeAll(); try super.tearDownWithError()
    }
    private func fixture() throws -> RecoveryServiceFixture {
        let asset = try XCTUnwrap(Bundle.main.url(forResource: "agent", withExtension: "js", subdirectory: "HostRuntime"))
        let f = RecoveryServiceFixture(root: root.appendingPathComponent(UUID().uuidString), asset: try Data(contentsOf: asset))
        fixtures.append(f); f.observe(); return f
    }
    private func receipt(_ trigger: String, _ expected: String, _ actual: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: ["trigger": trigger, "expected": expected, "actual": actual, "realModelCalls": 0, "realCloudHTTPCalls": 0, "realEventKitCalls": 0], options: [.sortedKeys, .prettyPrinted])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "G4-native-recovery-outcome"; attachment.lifetime = .keepAlways; add(attachment)
    }
    func testOfflineHeartbeatRecoversReadinessWithoutInventingTasks() throws {
        let f = try fixture(); try f.configure(f.a)
        f.lock.lock(); f.offline = true; f.lock.unlock()
        f.service.backend.queue.async { f.service.backend.heartbeat() }
        try f.until { try f.service.backend.state(binding: f.a)["errorCode"] as? String == "cloud_transport_uncertain" }
        XCTAssertEqual(try f.service.backend.state(binding: f.a)["ready"] as? Bool, false)
        let rejected = try f.call(f.a, "sessionTimeline.sessionCreateOptions", [])
        XCTAssertEqual((rejected["error"] as? [String: Any])?["code"] as? String, "host_not_ready")
        f.lock.lock(); f.offline = false; f.lock.unlock()
        f.service.backend.queue.async { f.service.backend.heartbeat() }
        try f.until { try f.service.backend.state(binding: f.a)["ready"] as? Bool == true }
        XCTAssertTrue((try f.service.backend.store!.snapshot()["inputs"] as? [String: Any])?.isEmpty == true)
        XCTAssertTrue(f.modelCalls.isEmpty); XCTAssertEqual(f.calendar.writes, 0)
        try receipt("Fail HTTP heartbeat with notConnectedToInternet, then restore the mock transport and reconcile", "Unavailable while offline; actual subscriptions/heartbeat/inbox restore ready without creating tasks", ["readyAfter": true, "modelCalls": 0, "calendarWrites": 0])
    }
    func testOwnerABARetirementRejectsLateDataAndNeverContinuesOldTask() throws {
        let f = try fixture(); try f.configure(f.a)
        _ = try f.call(f.a, "appSettings.update", ["notifications", ["enabled": false, "sound": true]])
        let agentA = try f.seedAgent(f.a)
        f.lock.lock(); f.holdOwners.insert(f.a.ownerId); f.holdCatalog = true; f.lock.unlock()
        let jobA = try f.input(f.a, agentA, text: "Private task belonging only to synthetic owner A")
        try loopRequire(f.modelStarted.wait(timeout: .now() + 15) == .success, "Original model did not reach the held callback")
        let late = DispatchSemaphore(value: 0); var oldReply: [String: Any]?
        f.service.hostCall(["expectedBinding": f.wire(f.a), "id": UUID().uuidString.lowercased(), "channel": "sessionTimeline.sessionCreateModels", "args": [["harness": "pi"]]]) { oldReply = $0; late.signal() }
        try loopRequire(f.catalogStarted.wait(timeout: .now() + 15) == .success, "Original catalog did not reach the held HTTP callback")
        try f.stop(f.a)
        let oldDisk = try GuguIOSBackendStore(root: f.root.appendingPathComponent("service/backend"), binding: f.a)
        XCTAssertEqual(try oldDisk.record("inputs", id: jobA)?["status"] as? String, "cancelled")
        f.lock.lock(); f.current = f.b; f.lock.unlock(); try f.configure(f.b)
        XCTAssertEqual((try f.call(f.b, "appSettings.get", ["notifications"])["error"] as? [String: Any])?["code"] as? String, "settings_unavailable")
        _ = try f.call(f.b, "appSettings.update", ["notifications", ["enabled": true, "sound": false]])
        f.lock.lock(); let catalog = f.heldCatalog; f.heldCatalog = nil; f.lock.unlock(); try XCTUnwrap(catalog)()
        try loopRequire(late.wait(timeout: .now() + 15) == .success, "Late old-owner catalog receipt did not settle")
        XCTAssertEqual((oldReply?["error"] as? [String: Any])?["code"] as? String, "stale_context")
        XCTAssertNil(oldReply?["result"])
        let oldCall = try f.call(f.a, "sessionTimeline.sessionSend", [["conversationId": agentA["sessionId"]!, "text": "must not cross owners"]])
        XCTAssertEqual((oldCall["error"] as? [String: Any])?["code"] as? String, "stale_context")
        let agentB = try f.seedAgent(f.b), jobB = try f.input(f.b, agentB, text: "Synthetic owner B task")
        try f.until { try f.service.backend.store!.record("inputs", id: jobB)?["replyStatus"] as? String == "settled" }
        let ownerB = String(decoding: try JSONSerialization.data(withJSONObject: f.service.backend.store!.snapshot()), as: UTF8.self)
        XCTAssertFalse(ownerB.contains(agentA["sessionId"] as! String)); XCTAssertFalse(ownerB.contains("Private task belonging only"))
        try f.stop(f.b)
        f.lock.lock(); f.current = f.a; f.holdOwners.remove(f.a.ownerId); let oldModel = f.heldModels.removeValue(forKey: f.a.ownerId); f.lock.unlock()
        try f.configure(f.a)
        try XCTUnwrap(oldModel)(RecoveryModel.lateWrite)
        let fresh = try f.input(f.a, agentA, text: "New explicit task after returning to owner A")
        try f.until { try f.service.backend.store!.record("inputs", id: fresh)?["replyStatus"] as? String == "settled" }
        XCTAssertEqual(try oldDisk.record("inputs", id: jobA)?["status"] as? String, "cancelled")
        XCTAssertEqual(f.modelCalls[f.a.ownerId], 2); XCTAssertEqual(f.modelCalls[f.b.ownerId], 1)
        XCTAssertGreaterThanOrEqual(f.modelCancellations, 1); XCTAssertEqual(f.calendar.writes, 0)
        XCTAssertEqual(try GuguIOSLocalAppSettings(store: oldDisk).get()["enabled"] as? Bool, false)
        try receipt("Hold A model/catalog callbacks; stop A; configure B on the same install; release old catalog; return to A and release old tool response", "Old data is stale, B has no A tasks/settings, old A task remains cancelled, and only new explicit inputs run", ["A_modelCalls": 2, "B_modelCalls": 1, "lateCatalogCode": "stale_context", "oldTask": "cancelled", "calendarWrites": 0, "BContainsASession": false])
    }
}
#endif
