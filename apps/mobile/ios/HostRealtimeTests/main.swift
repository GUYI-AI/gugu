import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ text: String) throws {
    if !condition() { throw GuguHostFailure(code: "realtime_test_failed", message: text) }
}
private final class SocketFixture: GuguIOSRealtimeSocket {
    let lock = NSLock()
    var frames: [[String: Any]] = [], queued: [String] = [], callback: ((Result<String, Error>) -> Void)?
    var closed = false, mismatchBroadcastACK = false
    func resume() {}
    func send(_ text: String, completion: @escaping (Error?) -> Void) {
        let frame = try! JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        lock.lock(); frames.append(frame); lock.unlock(); completion(nil)
        let wrong = mismatchBroadcastACK && frame["event"] as? String == "broadcast"
        emit(["event": "phx_reply", "topic": wrong ? "realtime:wrong" : frame["topic"]!, "ref": frame["ref"]!, "join_ref": frame["join_ref"] ?? NSNull(), "payload": ["status": "ok", "response": [:]]])
    }
    func receive(completion: @escaping (Result<String, Error>) -> Void) {
        lock.lock()
        if !queued.isEmpty { let next = queued.removeFirst(); lock.unlock(); completion(.success(next)) }
        else { callback = completion; lock.unlock() }
    }
    func emit(_ frame: [String: Any]) {
        let text = String(decoding: try! JSONSerialization.data(withJSONObject: frame), as: UTF8.self)
        lock.lock()
        if let callback { self.callback = nil; lock.unlock(); callback(.success(text)) }
        else { queued.append(text); lock.unlock() }
    }
    func snapshot() -> [[String: Any]] { lock.lock(); defer { lock.unlock() }; return frames }
    func close() { lock.lock(); closed = true; callback = nil; lock.unlock() }
}
@main struct HostRealtimeTests {
    static func wait(_ semaphore: DispatchSemaphore) throws { try require(semaphore.wait(timeout: .now() + 5) == .success, "Native Realtime callback timed out") }
    static func main() throws {
        let owner = UUID().uuidString.lowercased(), install = UUID().uuidString.lowercased()
        let binding = GuguIOSHostBinding(ownerId: owner, deviceId: "phone-\(install)-\(owner)", installationId: install)
        var allowed = true
        let socket = SocketFixture(), opened = DispatchSemaphore(value: 0), received = DispatchSemaphore(value: 0), unavailable = DispatchSemaphore(value: 0)
        var suppliedURL: URL?, delivered = 0
        let transport = try GuguIOSRealtimeTransport(configuration: .init(version: 1, supabaseUrl: "https://fixture.invalid/prefix", anonKey: "public-fixture"), binding: binding, credentials: { expected in
            guard allowed, expected == binding else { throw GuguHostFailure(code: "stale_context", message: "Synthetic publication retired") }
            return .init(binding: binding, accessToken: "synthetic-human-native-only", expiresAt: Date().addingTimeInterval(3600))
        }, makeSocket: { suppliedURL = $0; return socket })
        let topic = "gugu:\(binding.deviceId):rpc"
        transport.join(name: topic, receive: { event, value in if event == "broadcast", value["request_id"] as? String == "synthetic-original-id" { delivered += 1; received.signal() } }, availability: { value in if value { opened.signal() } else { unavailable.signal() } })
        transport.open(); try wait(opened)
        try require(suppliedURL?.scheme == "wss" && suppliedURL?.path == "/prefix/realtime/v1/websocket", "Realtime lost packaged endpoint prefix")
        try require(suppliedURL?.absoluteString.contains("synthetic-human") == false, "Human token entered WebSocket URL")
        let join = socket.snapshot().first!, payload = join["payload"] as! [String: Any], config = payload["config"] as! [String: Any]
        try require(join["event"] as? String == "phx_join" && config["private"] as? Bool == true && payload["access_token"] as? String == "synthetic-human-native-only", "Private native join contract differs")
        var cases = ["packaged_WSS_endpoint_private_join_and_native_only_token"]
        let acknowledged = DispatchSemaphore(value: 0); var outcome: Result<Void, Error>?
        transport.broadcast(name: topic, payload: ["type": "taskhost.alive"]) { outcome = $0; acknowledged.signal() }; try wait(acknowledged); _ = try outcome!.get()
        try require(socket.snapshot().filter { $0["event"] as? String == "broadcast" }.count == 1, "Broadcast was repeated")
        cases.append("broadcast_requires_matching_known_ACK_and_is_sent_once")
        socket.emit(["event": "broadcast", "topic": "realtime:\(topic)", "join_ref": join["join_ref"]!, "payload": ["event": "broadcast", "payload": ["request_id": "synthetic-original-id"]]])
        try wait(received); try require(delivered == 1, "Authorized native frame not delivered")
        cases.append("current_private_channel_frame_is_delivered")
        let denied = DispatchSemaphore(value: 0)
        transport.join(name: "gugu:other-device:rpc", receive: { _, _ in }, availability: { value in if !value { denied.signal() } }); try wait(denied)
        try require(socket.snapshot().filter { $0["event"] as? String == "phx_join" }.count == 1, "Another device topic was joined")
        cases.append("another_device_topic_rejected_before_socket_send")
        socket.mismatchBroadcastACK = true
        transport.broadcast(name: topic, payload: ["type": "synthetic-mutation", "request_id": "original-no-replay"]) { outcome = $0; acknowledged.signal() }
        try wait(acknowledged)
        guard case .failure = outcome! else { throw GuguHostFailure(code: "realtime_test_failed", message: "Wrong topic ACK was accepted") }
        // Seal publication before queued reconnect; no new account is selected.
        allowed = false
        transport.close(); try wait(unavailable)
        try require(socket.snapshot().filter { (($0["payload"] as? [String: Any])?["payload"] as? [String: Any])?["request_id"] as? String == "original-no-replay" }.count == 1, "Unknown mutation was automatically replayed")
        cases.append("wrong_topic_ACK_fails_original_call_without_mutation_replay")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["kind": "native_Realtime_protocol_with_synthetic_socket", "result": "pass", "cases": cases, "realWebSocketConnections": 0, "realModelCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
