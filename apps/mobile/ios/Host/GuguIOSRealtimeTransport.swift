import Foundation

protocol GuguIOSRealtimeSocket: AnyObject {
    func resume()
    func send(_ text: String, completion: @escaping (Error?) -> Void)
    func receive(completion: @escaping (Result<String, Error>) -> Void)
    func close()
}
private final class GuguIOSURLSocket: NSObject, GuguIOSRealtimeSocket, URLSessionTaskDelegate {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    init(url: URL) {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
    }
    func resume() { task.resume() }
    func send(_ text: String, completion: @escaping (Error?) -> Void) { task.send(.string(text), completionHandler: completion) }
    func receive(completion: @escaping (Result<String, Error>) -> Void) {
        task.receive { result in completion(result.flatMap { value in
            switch value {
            case .string(let text): return .success(text)
            default: return .failure(GuguHostFailure(code: "realtime_protocol_error", message: "Expected protocol 1 text frame"))
            }
        }) }
    }
    func close() { task.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Supabase Realtime protocol 1.0.0, matching the existing Android private
/// topics. Credentials stay native; only subscription setup reconnects. No
/// unacknowledged broadcast/mutation is automatically sent a second time.
final class GuguIOSRealtimeTransport {
    typealias SocketFactory = (URL) throws -> GuguIOSRealtimeSocket
    private struct Topic {
        let receive: (String, [String: Any]) -> Void
        let availability: (Bool) -> Void
        var joinRef: String?
        var joined = false
    }
    private struct Pending {
        let topic: String
        let done: (Result<Void, Error>) -> Void
        let timeout: DispatchWorkItem
    }
    private let queue = DispatchQueue(label: "app.gugu.ios.realtime")
    private let url: URL
    private let binding: GuguIOSHostBinding
    private let credentials: GuguIOSCloudBroker.Credentials
    private let makeSocket: SocketFactory
    private var socket: GuguIOSRealtimeSocket?
    private var topics: [String: Topic] = [:]
    private var pending: [String: Pending] = [:]
    private var reference: UInt64 = 0
    private var generation: UInt64 = 0
    private var stopped = true
    private var disconnecting = false
    private var reconnectDelay: Double = 1
    private var heartbeat: DispatchWorkItem?
    private var reconnect: DispatchWorkItem?
    private var token: String?

    init(configuration: GuguIOSBackendConfiguration, binding: GuguIOSHostBinding,
         credentials: @escaping GuguIOSCloudBroker.Credentials, makeSocket: @escaping SocketFactory = { GuguIOSURLSocket(url: $0) }) throws {
        try binding.validate(); self.binding = binding; self.credentials = credentials; self.makeSocket = makeSocket
        var components = URLComponents(url: try configuration.baseURL().appendingPathComponent("realtime/v1/websocket"), resolvingAgainstBaseURL: false)!
        components.scheme = "wss"; components.queryItems = [.init(name: "apikey", value: configuration.anonKey), .init(name: "vsn", value: "1.0.0")]
        guard let url = components.url else { throw Self.failure("backend_not_configured", "Invalid packaged Realtime endpoint") }; self.url = url
    }
    func join(name: String, receive: @escaping (String, [String: Any]) -> Void, availability: @escaping (Bool) -> Void) {
        queue.async {
            guard self.validTopic(name) else { availability(false); return }
            if self.topics[name] != nil { availability(self.topics[name]?.joined == true); return }
            self.topics[name] = Topic(receive: receive, availability: availability)
            if self.socket != nil { self.joinTopic(name) }
        }
    }
    func open() { queue.async { guard self.stopped else { return }; self.stopped = false; self.reconnect = nil; self.connect() } }
    func leave(name: String) {
        queue.async {
            guard let topic = self.topics.removeValue(forKey: name) else { return }
            topic.availability(false)
            for (ref, value) in self.pending where value.topic == "realtime:\(name)" {
                self.pending.removeValue(forKey: ref); value.timeout.cancel()
                value.done(.failure(Self.failure("cancelled", "Native topic was left")))
            }
            if topic.joined { self.push(topic: "realtime:\(name)", event: "phx_leave", payload: [:], joinRef: topic.joinRef) { _ in } }
        }
    }
    func broadcast(name: String, event: String = "broadcast", payload: [String: Any], completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            do {
                try self.check()
                guard !self.stopped, let topic = self.topics[name], topic.joined else { throw Self.failure("host_not_ready", "Native private channel is unavailable") }
                try GuguIOSCloudBroker.rejectCredentials(payload)
                self.push(topic: "realtime:\(name)", event: "broadcast", payload: ["type": "broadcast", "event": event, "payload": payload], joinRef: topic.joinRef, completion: completion)
            } catch { completion(.failure(error)) }
        }
    }
    func close(completion: @escaping () -> Void = {}) {
        queue.async {
            self.stopped = true; self.generation &+= 1; self.heartbeat?.cancel(); self.reconnect?.cancel()
            self.socket?.close(); self.socket = nil; self.token = nil
            for key in self.topics.keys { self.topics[key]?.joined = false; self.topics[key]?.availability(false) }
            self.failPending(Self.failure("cancelled", "Native Realtime transport closed"))
            completion()
        }
    }
    private func connect() {
        guard !stopped else { return }
        reconnect = nil
        do {
            try check(); token = try credentials(binding).accessToken
            generation &+= 1; let epoch = generation
            let socket = try makeSocket(url); self.socket = socket; socket.resume()
            receive(epoch)
            for name in topics.keys { joinTopic(name) }
            armHeartbeat(epoch)
        } catch { disconnected(error) }
    }
    private func joinTopic(_ name: String) {
        do {
            try check()
            guard !stopped, topics[name] != nil else { return }
            reference &+= 1; let ref = String(reference)
            topics[name]?.joinRef = ref; topics[name]?.joined = false
            let payload: [String: Any] = ["config": ["private": true, "broadcast": ["self": false, "ack": true], "presence": ["enabled": false], "postgres_changes": []], "access_token": try credentials(binding).accessToken]
            push(topic: "realtime:\(name)", event: "phx_join", payload: payload, joinRef: ref, reference: ref) { result in
                guard self.topics[name]?.joinRef == ref else { return }
                do { _ = try result.get(); try self.check()
                    self.topics[name]?.joined = true; self.reconnectDelay = 1; self.topics[name]?.availability(true)
                } catch { self.disconnected(error) }
            }
        } catch { disconnected(error) }
    }
    private func receive(_ epoch: UInt64) {
        socket?.receive { result in self.queue.async {
            guard !self.stopped, self.generation == epoch else { return }
            do {
                try self.check(); let text = try result.get()
                guard let frame = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                      let event = frame["event"] as? String, let topic = frame["topic"] as? String,
                      let payload = frame["payload"] as? [String: Any] else { throw Self.failure("realtime_protocol_error", "Invalid native private-channel frame") }
                if event == "phx_reply", let ref = frame["ref"] as? String, let pending = self.pending.removeValue(forKey: ref) {
                    pending.timeout.cancel()
                    guard pending.topic == topic else {
                        let error = Self.failure("realtime_protocol_error", "Realtime acknowledgement targets another channel")
                        pending.done(.failure(error)); self.disconnected(error); return
                    }
                    pending.done(payload["status"] as? String == "ok" ? .success(()) : .failure(Self.failure("realtime_rejected", "Private channel operation was rejected")))
                } else if event == "phx_error" || event == "phx_close" { throw Self.failure("realtime_closed", "Native private channel closed") }
                else if event == "broadcast", topic.hasPrefix("realtime:"),
                        let selected = self.topics[String(topic.dropFirst("realtime:".count))], selected.joined,
                        let deliveredEvent = payload["event"] as? String, let value = payload["payload"] as? [String: Any] {
                    if let joinRef = frame["join_ref"] as? String, joinRef != selected.joinRef { self.receive(epoch); return }
                    selected.receive(deliveredEvent, value)
                }
                self.receive(epoch)
            } catch { self.disconnected(error) }
        } }
    }
    private func push(topic: String, event: String, payload: [String: Any], joinRef: String?, reference supplied: String? = nil,
                      completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            guard let socket, !stopped else { throw Self.failure("host_not_ready", "Native Realtime socket is unavailable") }
            reference &+= 1; let ref = supplied ?? String(reference)
            let frame: [String: Any] = ["topic": topic, "event": event, "payload": payload, "ref": ref, "join_ref": joinRef as Any? ?? NSNull()]
            let text = String(decoding: try JSONSerialization.data(withJSONObject: frame, options: [.withoutEscapingSlashes]), as: UTF8.self)
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, let pending = self.pending.removeValue(forKey: ref) else { return }
                pending.done(.failure(Self.failure("realtime_ack_uncertain", "Private channel acknowledgement timed out")))
                self.disconnected(Self.failure("realtime_ack_uncertain", "Native private channel is unresponsive"))
            }
            pending[ref] = Pending(topic: topic, done: completion, timeout: timeout)
            queue.asyncAfter(deadline: .now() + 15, execute: timeout)
            let epoch = generation
            socket.send(text) { error in self.queue.async {
                guard self.generation == epoch, let error else { return }
                self.disconnected(error)
            } }
        } catch { completion(.failure(error)) }
    }
    private func armHeartbeat(_ epoch: UInt64) {
        heartbeat?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stopped, self.generation == epoch else { return }
            do {
                try self.check(); let next = try self.credentials(self.binding).accessToken
                if next != self.token {
                    for (name, topic) in self.topics where topic.joined {
                        self.push(topic: "realtime:\(name)", event: "access_token", payload: ["access_token": next], joinRef: topic.joinRef) { result in
                            if case .failure(let error) = result { self.disconnected(error) }
                        }
                    }
                    self.token = next
                }
                self.push(topic: "phoenix", event: "heartbeat", payload: [:], joinRef: nil) { result in
                    if case .failure(let error) = result { self.disconnected(error) }
                }
                self.armHeartbeat(epoch)
            } catch { self.disconnected(error) }
        }
        heartbeat = work; queue.asyncAfter(deadline: .now() + 20, execute: work)
    }
    private func disconnected(_ error: Error) {
        guard !stopped, !disconnecting, !(socket == nil && reconnect != nil) else { return }
        disconnecting = true; defer { disconnecting = false }
        generation &+= 1; heartbeat?.cancel(); reconnect?.cancel(); socket?.close(); socket = nil; token = nil
        for name in topics.keys { topics[name]?.joined = false; topics[name]?.joinRef = nil; topics[name]?.availability(false) }
        failPending(Self.failure("realtime_ack_uncertain", "Private channel request has no known acknowledgement"))
        // A sealed/different owner never reconnects by selecting current identity.
        guard (try? credentials(binding)) != nil else { stopped = true; return }
        let work = DispatchWorkItem { [weak self] in self?.connect() }; reconnect = work
        queue.asyncAfter(deadline: .now() + reconnectDelay, execute: work); reconnectDelay = min(30, reconnectDelay * 2)
    }
    private func failPending(_ error: Error) {
        let values = pending; pending.removeAll()
        for value in values.values { value.timeout.cancel(); value.done(.failure(error)) }
    }
    private func check() throws {
        let value = try credentials(binding)
        guard value.binding == binding, value.expiresAt > Date() else { throw Self.failure("stale_context", "Native Realtime owner publication changed") }
    }
    private func validTopic(_ name: String) -> Bool {
        let base = "gugu:\(binding.deviceId)"
        if name == "\(base):rpc" || name == "\(base):commands" { return true }
        let prefix = "\(base):rpc:"
        guard name.hasPrefix(prefix) else { return false }
        return String(name.dropFirst(prefix.count)).range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil
    }
    private static func failure(_ code: String, _ message: String) -> GuguHostFailure { GuguHostFailure(code: code, message: message) }
}
