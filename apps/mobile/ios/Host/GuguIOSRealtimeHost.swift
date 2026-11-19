import Foundation

/// The existing Android device RPC envelope. Availability comes from both real
/// private subscriptions; it is not inferred from having a socket object.
final class GuguIOSRealtimeHost {
    typealias Invoke = (String, [Any], String, @escaping ([String: Any]) -> Void) -> Void
    private struct Peer {
        var joined = false
        var lastAsked = Date()
        var attaches: [String] = []
        var requests: [String: String] = [:]
    }
    private let queue = DispatchQueue(label: "app.gugu.ios.realtime-host")
    private let binding: GuguIOSHostBinding
    private let transport: GuguIOSRealtimeTransport
    private let protocolVersion: Int
    private let minimumProtocol: Int
    private let check: () throws -> Void
    private let invoke: Invoke
    private let command: () -> Void
    private let connectivity: (Bool) -> Void
    private var sharedAvailable = false
    private var commandsAvailable = false
    private var stopped = true
    private var peers: [String: Peer] = [:]
    private var alive: DispatchWorkItem?
    private var shared: String { "gugu:\(binding.deviceId):rpc" }

    init(binding: GuguIOSHostBinding, transport: GuguIOSRealtimeTransport, protocolVersion: Int, minimumProtocol: Int,
         check: @escaping () throws -> Void, invoke: @escaping Invoke, command: @escaping () -> Void, connectivity: @escaping (Bool) -> Void) {
        self.binding = binding; self.transport = transport; self.protocolVersion = protocolVersion; self.minimumProtocol = minimumProtocol
        self.check = check; self.invoke = invoke; self.command = command; self.connectivity = connectivity
    }
    func open() {
        queue.async {
            guard self.stopped else { return }; self.stopped = false
            self.transport.join(name: self.shared, receive: { event, payload in self.queue.async {
                if event == "broadcast" { self.sharedMessage(payload) }
            } }, availability: { value in self.queue.async {
                guard !self.stopped else { return }; self.sharedAvailable = value; self.publishConnectivity()
                if value { self.send(self.shared, ["type": "taskhost.ready"]); self.command() }
            } })
            self.transport.join(name: "gugu:\(self.binding.deviceId):commands", receive: { event, _ in self.queue.async {
                if !self.stopped && event == "command_created" { self.command() }
            } }, availability: { value in self.queue.async {
                guard !self.stopped else { return }; self.commandsAvailable = value; self.publishConnectivity()
                if value { self.command() }
            } })
            self.transport.open(); self.armAlive()
        }
    }
    func close(completion: @escaping () -> Void) {
        queue.async {
            self.stopped = true; self.alive?.cancel(); self.sharedAvailable = false; self.commandsAvailable = false; self.connectivity(false)
            self.peers.removeAll(); self.transport.close(completion: completion)
        }
    }
    private func sharedMessage(_ value: [String: Any]) {
        guard !stopped, (try? check()) != nil, let request = request(value) else { return }
        guard request.type == "taskhost.attach" else {
            reply(shared, request, error("client_outdated", "请更新发起调用的那台设备上的咕咕")); return
        }
        guard let body = request.body as? [String: Any], let asker = body["asker"] as? String,
              asker.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil,
              let version = body["protocol"] as? Int, version >= minimumProtocol else {
            reply(shared, request, error("client_outdated", "发起调用的一端版本太旧或连接信息无效")); return
        }
        if peers[asker] != nil {
            peers[asker]?.lastAsked = Date()
            if peers[asker]?.joined == true { reply(peerName(asker), request, ["result": ["attached": true, "protocol": protocolVersion]]) }
            else { peers[asker]?.attaches.append(request.id) }
            return
        }
        peers[asker] = Peer(attaches: [request.id])
        transport.join(name: peerName(asker), receive: { event, value in self.queue.async {
            if event == "broadcast" { self.peerMessage(asker, value) }
        } }, availability: { value in self.queue.async {
            guard !self.stopped, self.peers[asker] != nil else { return }
            self.peers[asker]?.joined = value
            if value {
                let ids = self.peers[asker]?.attaches ?? []; self.peers[asker]?.attaches.removeAll()
                for id in ids { self.reply(self.peerName(asker), Request(type: "taskhost.attach", id: id, body: NSNull()), ["result": ["attached": true, "protocol": self.protocolVersion]]) }
            }
        } })
    }
    private func peerMessage(_ asker: String, _ value: [String: Any]) {
        guard !stopped, (try? check()) != nil, peers[asker]?.joined == true, let request = request(value) else { return }
        peers[asker]?.lastAsked = Date()
        guard request.type == "taskhost.call", let body = request.body as? [String: Any], let channel = body["channel"] as? String, let args = body["args"] as? [Any] else {
            reply(peerName(asker), request, error(request.type.hasPrefix("device.action") ? "device_scope_mismatch" : "unknown_method", "请通过这台手机上的任务 Agent 委托本机工作")); return
        }
        do {
            let fingerprint = try GuguHostJournal.digest(["channel": channel, "args": args])
            if let prior = peers[asker]?.requests[request.id] {
                if prior != fingerprint { reply(peerName(asker), request, error("duplicate_conflict", "原请求编号不能更换内容")) }
                return
            }
            peers[asker]?.requests[request.id] = fingerprint
            invoke(channel, args, request.id) { result in self.queue.async {
                self.peers[asker]?.requests.removeValue(forKey: request.id)
                guard !self.stopped, self.peers[asker]?.joined == true, (try? self.check()) != nil else { return }
                if let failure = result["error"] as? [String: Any] { self.reply(self.peerName(asker), request, ["error": failure]) }
                else if result.keys.contains("result") { self.reply(self.peerName(asker), request, ["result": ["value": result["result"]!]]) }
                else { self.reply(self.peerName(asker), request, self.error("invalid_backend_reply", "本机任务没有返回可核验结果")) }
            } }
        } catch { reply(peerName(asker), request, self.error("invalid_args", "本机任务请求无法编码")) }
    }
    private struct Request { let type: String; let id: String; let body: Any }
    private func request(_ value: [String: Any]) -> Request? {
        guard let type = value["type"] as? String, !type.hasSuffix(":reply"), let id = value["request_id"] as? String,
              UUID(uuidString: id) != nil, value["user_id"] as? String == binding.ownerId else { return nil }
        return Request(type: type, id: id, body: value["payload"] ?? NSNull())
    }
    private func reply(_ name: String, _ request: Request, _ body: [String: Any]) {
        var result = body; result["type"] = "\(request.type):reply"; result["request_id"] = request.id; send(name, result)
    }
    private func send(_ name: String, _ payload: [String: Any]) {
        transport.broadcast(name: name, payload: payload) { result in
            if case .failure = result { /* The durable host call owns reconciliation; never resend here. */ }
        }
    }
    private func publishConnectivity() { connectivity(!stopped && sharedAvailable && commandsAvailable) }
    private func peerName(_ asker: String) -> String { "\(shared):\(asker)" }
    private func armAlive() {
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stopped else { return }
            if self.sharedAvailable { self.send(self.shared, ["type": "taskhost.alive"]) }
            for (asker, peer) in self.peers {
                if Date().timeIntervalSince(peer.lastAsked) > 300 {
                    self.send(self.peerName(asker), ["type": "taskhost.detached"]); self.transport.leave(name: self.peerName(asker)); self.peers.removeValue(forKey: asker)
                } else if peer.joined { self.send(self.peerName(asker), ["type": "taskhost.alive"]) }
            }
            self.armAlive()
        }
        alive = work; queue.asyncAfter(deadline: .now() + 60, execute: work)
    }
    private func error(_ code: String, _ text: String) -> [String: Any] { ["error": ["code": code, "message": text, "admission": "rejected"]] }
}
