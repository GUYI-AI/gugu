import Foundation

/// A device wake carries no executable prompt. Claim its original command,
/// read the authoritative inbox, and settle only after durable input/ACK work.
final class GuguIOSDeliveryCommand {
    private let queue = DispatchQueue(label: "app.gugu.ios.delivery-command")
    private let store: GuguIOSBackendStore
    private let broker: GuguIOSCloudBroker
    private let pump: GuguIOSInboxPump
    private let instanceId: String
    private let check: () throws -> Void
    private var active: Set<String> = []
    init(store: GuguIOSBackendStore, broker: GuguIOSCloudBroker, pump: GuguIOSInboxPump,
         instanceId: String, check: @escaping () throws -> Void) {
        self.store = store; self.broker = broker; self.pump = pump; self.instanceId = instanceId; self.check = check
    }
    func execute(id: String, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            var entered = false
            do {
                try self.check()
                guard UUID(uuidString: id) != nil, !self.active.contains(id) else {
                    throw Self.failure("admission_uncertain", "Original inbox wake is already in flight or invalid")
                }
                self.active.insert(id); entered = true
                let done: (Result<Void, Error>) -> Void = { result in self.queue.async { self.active.remove(id); completion(result) } }
                let saved = try self.store.admit("requests", id: "command:\(id)", fingerprint: id) {
                    ["kind": "delivery-command", "claimToken": UUID().uuidString.lowercased(), "instanceId": self.instanceId, "status": "pending"]
                }
                guard saved["kind"] as? String == "delivery-command", let claim = saved["claimToken"] as? String else {
                    throw Self.failure("duplicate_conflict", "Command ID belongs to another native operation")
                }
                self.read(id, claim: claim, completion: done)
            } catch { if entered { self.active.remove(id) }; completion(.failure(error)) }
        }
    }
    private func read(_ id: String, claim: String, completion: @escaping (Result<Void, Error>) -> Void) {
        perform(.readCommand(id)) { result in
            do {
                guard let rows = try result.get() as? [[String: Any]], rows.count == 1 else { throw Self.failure("cloud_protocol_error", "Inbox wake has no unique cloud command") }
                let command = rows[0]
                guard command["id"] as? String == id, command["device_id"] as? String == self.store.binding.deviceId,
                      command["type"] as? String == "agent.deliver", let payload = command["payload"] as? [String: Any],
                      payload["source"] == nil || payload["source"] is NSNull,
                      let agent = payload["agent_user_id"] as? String, UUID(uuidString: agent) != nil else {
                    throw Self.failure("unsupported", "Inbox wake does not reference an existing chat recipient")
                }
                switch command["status"] as? String {
                case "pending":
                    self.perform(.claimCommand(id: id, claimToken: claim, instanceId: self.instanceId, at: Self.now())) { result in
                        do {
                            guard let rows = try result.get() as? [[String: Any]], rows.count == 1,
                                  rows[0]["id"] as? String == id, rows[0]["claim_token"] as? String == claim else {
                                throw Self.failure("admission_uncertain", "Inbox wake claim was not confirmed")
                            }
                            self.read(id, claim: claim, completion: completion)
                        }
                        catch { completion(.failure(error)) }
                    }
                case "running":
                    guard command["claim_token"] as? String == claim, command["claimed_by"] as? String == self.instanceId else {
                        throw Self.failure("admission_uncertain", "Inbox wake is held by another claim or runtime")
                    }
                    self.perform(.recheckCommand(id: id, claimToken: claim)) { result in
                        do { guard try result.get() as? Bool == true else { throw Self.failure("stale_context", "Inbox wake claim expired") } }
                        catch { completion(.failure(error)); return }
                        self.pump.pull(agentId: agent) { result in self.queue.async {
                            do {
                                let count = try result.get(); try self.check()
                                let receipt: [String: Any] = ["agent_user_id": agent, "delivered": count > 0]
                                self.perform(.recheckCommand(id: id, claimToken: claim)) { result in
                                    do { guard try result.get() as? Bool == true else { throw Self.failure("stale_context", "Inbox wake claim changed before settlement") } }
                                    catch { completion(.failure(error)); return }
                                    self.perform(.completeCommand(id: id, claimToken: claim, result: receipt, at: Self.now())) { result in
                                        do {
                                            guard let rows = try result.get() as? [[String: Any]], rows.count == 1, rows[0]["id"] as? String == id else {
                                                throw Self.failure("admission_uncertain", "Inbox wake did not confirm its original settlement")
                                            }
                                            try self.store.update("requests", id: "command:\(id)") { $0["status"] = "completed"; $0["result"] = receipt }
                                            completion(.success(()))
                                        } catch { completion(.failure(error)) }
                                    }
                                }
                            } catch { completion(.failure(error)) }
                        } }
                    }
                case "done":
                    guard let receipt = command["result"] as? [String: Any], receipt["agent_user_id"] as? String == agent,
                          receipt["delivered"] is Bool else { throw Self.failure("cloud_protocol_error", "Completed inbox wake has no matching receipt") }
                    try self.store.update("requests", id: "command:\(id)") { $0["status"] = "completed"; $0["result"] = receipt }
                    completion(.success(()))
                default: throw Self.failure("command_unavailable", "Inbox wake is not pending, owned or completed")
                }
            } catch { completion(.failure(error)) }
        }
    }
    private func perform(_ operation: GuguIOSCloudOperation, completion: @escaping (Result<Any, Error>) -> Void) {
        do { try check() } catch { completion(.failure(error)); return }
        broker.perform(operation, binding: store.binding) { result in self.queue.async {
            do { try self.check(); completion(.success(try result.get())) } catch { completion(.failure(error)) }
        } }
    }
    private static func now() -> String { ISO8601DateFormatter().string(from: Date()) }
    private static func failure(_ code: String, _ message: String) -> GuguHostFailure { .init(code: code, message: message) }
}
