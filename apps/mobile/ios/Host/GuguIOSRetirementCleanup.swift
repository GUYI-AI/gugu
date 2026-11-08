import Foundation

/// Explicit native cleanup of an already quiesced owner. Opening the runner
/// performs no request, owner publication, task recovery or uncertain replay.
final class GuguIOSRetirementCleanup {
    typealias Authorize = (GuguIOSHostBinding, String, GuguIOSRetirementOperation) throws -> GuguIOSRetirementAuthorization
    private static let custodyLock = NSLock()
    private static var busy: Set<String> = []
    let queue = DispatchQueue(label: "app.gugu.ios.retirement-cleanup")
    let root: URL
    let configuration: GuguIOSBackendConfiguration
    let authorize: Authorize
    let send: GuguIOSCloudBroker.Send?

    init(root: URL, configuration: GuguIOSBackendConfiguration, authorize: @escaping Authorize, send: GuguIOSCloudBroker.Send? = nil) throws {
        _ = try configuration.baseURL(); self.root = root; self.configuration = configuration; self.authorize = authorize; self.send = send
    }

    func retire(expectedBinding: GuguIOSHostBinding, retirementId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            var acquired: String?
            do {
                try expectedBinding.validate()
                guard UUID(uuidString: retirementId) != nil else { throw Self.failure("invalid_args", "Original native retirement ID is required") }
                _ = try GuguIOSRetirementHTTP.permit(self.authorize, binding: expectedBinding, retirementId: retirementId, operation: .readOwnedDevice)
                let store = try GuguIOSBackendStore(root: self.root.appendingPathComponent("backend"), binding: expectedBinding)
                Self.custodyLock.lock(); let inserted = Self.busy.insert(store.custodyKey).inserted; Self.custodyLock.unlock()
                guard inserted else { throw Self.failure("admission_uncertain", "Original retirement cleanup is already running") }; acquired = store.custodyKey
                let entries = try self.prepare(store, retirementId)
                let http = try GuguIOSRetirementHTTP(configuration: self.configuration, store: store, retirementId: retirementId, authorize: self.authorize, send: self.send)
                let custody = store.custodyKey
                let finish: (Error?) -> Void = { first in self.queue.async {
                    var failure = first
                    do {
                        _ = try GuguIOSRetirementHTTP.permit(self.authorize, binding: expectedBinding, retirementId: retirementId, operation: .readOwnedDevice)
                        let plan = try self.plan(store, retirementId)
                        if (plan["unknownKeys"] as? [String])?.isEmpty != true { throw Self.failure("model_issue_uncertain", "Original model issue has no known lease ID; it was not reissued") }
                        if failure == nil {
                            try store.transaction { state in
                                var requests = state["requests"] as? [String: [String: Any]] ?? [:]
                                guard requests["native-retirement"]?["retirementId"] as? String == retirementId,
                                      var original = requests["retirement:\(retirementId)"], original["deviceConfirmed"] as? Bool == true else { throw Self.failure("stale_context", "Original retirement receipt is incomplete") }
                                let leases = state["leases"] as? [String: [String: Any]] ?? [:]
                                guard entries.allSatisfy({ leases[$0["key"]!]?["status"] as? String == "settled" }) else { throw Self.failure("model_cleanup_pending", "Original lease cleanup remains unresolved") }
                                original["status"] = "completed"; requests["retirement:\(retirementId)"] = original
                                requests["native-retirement"] = ["retirementId": retirementId, "status": "completed"]; state["requests"] = requests
                            }
                        }
                    } catch { if failure == nil { failure = error } }
                    Self.custodyLock.lock(); Self.busy.remove(custody); Self.custodyLock.unlock()
                    completion(failure.map { .failure($0) } ?? .success(()))
                } }
                self.cleanLeases(store, retirementId, entries, http) { leaseError in
                    self.cleanDevice(store, retirementId, http) { deviceError in finish(leaseError ?? deviceError) }
                }
            } catch {
                if let acquired { Self.custodyLock.lock(); Self.busy.remove(acquired); Self.custodyLock.unlock() }
                completion(.failure(error))
            }
        }
    }

    private func prepare(_ store: GuguIOSBackendStore, _ id: String) throws -> [[String: String]] {
        try store.transaction { state in
            var requests = state["requests"] as? [String: [String: Any]] ?? [:]
            if let pointer = requests["native-retirement"], pointer["retirementId"] as? String != id, pointer["status"] as? String != "completed" {
                throw Self.failure("duplicate_conflict", "Another original retirement transaction remains pending")
            }
            let leases = state["leases"] as? [String: [String: Any]] ?? [:]
            let pendingKeys = leases.keys.filter { leases[$0]?["status"] as? String != "settled" }.sorted()
            var plan = requests["retirement:\(id)"] ?? ["status": "pending", "scopeKeys": pendingKeys, "leases": [[String: String]](), "unknownKeys": [String](), "progress": [String: Any](), "deviceConfirmed": false]
            guard let keys = plan["scopeKeys"] as? [String], Set(pendingKeys).isSubset(of: Set(keys)) else { throw Self.failure("stale_context", "Lease scope changed after retirement admission") }
            guard let captured = plan["leases"] as? [[String: String]], plan["progress"] is [String: [String: Bool]],
                  plan["unknownKeys"] is [String], plan["deviceConfirmed"] is Bool else { throw Self.failure("invalid_journal", "Original retirement plan is unreadable") }
            var entries = captured, unknown: [String] = []
            for key in keys {
                guard let row = leases[key], let agent = row["agentId"] as? String, UUID(uuidString: agent) != nil,
                      let session = row["sessionId"] as? String, UUID(uuidString: session) != nil,
                      let job = row["jobId"] as? String, UUID(uuidString: job) != nil, key == "issue:\(job)" else { throw Self.failure("invalid_journal", "Original model cleanup custody is unreadable") }
                guard let lease = row["leaseId"] as? String else { unknown.append(key); continue }
                guard UUID(uuidString: lease) != nil else { throw Self.failure("invalid_journal", "Original model lease identity is invalid") }
                if let original = entries.first(where: { $0["key"] == key }) {
                    guard original["leaseId"] == lease else { throw Self.failure("stale_context", "Original model lease identity changed") }
                } else {
                    guard !entries.contains(where: { $0["leaseId"] == lease }) else { throw Self.failure("invalid_journal", "A model lease belongs to multiple original jobs") }
                    entries.append(["key": key, "leaseId": lease])
                }
            }
            plan["leases"] = entries; plan["unknownKeys"] = unknown
            requests["retirement:\(id)"] = plan; requests["native-retirement"] = ["retirementId": id, "status": plan["status"] ?? "pending"]; state["requests"] = requests
            return entries
        }
    }
    func plan(_ store: GuguIOSBackendStore, _ id: String) throws -> [String: Any] {
        guard let value = try store.record("requests", id: "retirement:\(id)") else { throw Self.failure("record_unreadable", "Original retirement plan is unavailable") }; return value
    }
    private func cleanLeases(_ store: GuguIOSBackendStore, _ id: String, _ entries: [[String: String]], _ http: GuguIOSRetirementHTTP, completion: @escaping (Error?) -> Void) {
        var first: Error?
        func next(_ index: Int) {
            guard index < entries.count else { completion(first); return }
            let entry = entries[index], key = entry["key"]!, lease = entry["leaseId"]!
            do {
                if try store.record("leases", id: key)?["status"] as? String == "settled" { next(index + 1); return }
                func phase(_ checkpoint: Bool, _ done: @escaping () -> Void) {
                    do {
                        let field = checkpoint ? "checkpoint" : "revoke", progress = try self.plan(store, id)["progress"] as? [String: [String: Bool]] ?? [:]
                        if progress[key]?[field] == true { done(); return }
                        http.perform(checkpoint ? .checkpointLease(lease) : .revokeLease(lease), known: { _ in
                            try store.transaction { state in
                                var requests = state["requests"] as? [String: [String: Any]] ?? [:], leases = state["leases"] as? [String: [String: Any]] ?? [:]
                                guard var plan = requests["retirement:\(id)"], leases[key]?["leaseId"] as? String == lease else { throw Self.failure("stale_context", "Known lease result belongs to another cleanup record") }
                                var progress = plan["progress"] as? [String: [String: Bool]] ?? [:], flags = progress[key] ?? [:]
                                flags[field] = true; progress[key] = flags; plan["progress"] = progress; requests["retirement:\(id)"] = plan
                                if flags["checkpoint"] == true && flags["revoke"] == true { leases[key]?["status"] = "settled" }
                                state["requests"] = requests; state["leases"] = leases
                            }
                        }) { result in self.queue.async {
                            if case .failure(let error) = result, first == nil { first = error }; done()
                        } }
                    } catch { if first == nil { first = error }; done() }
                }
                phase(true) { phase(false) { next(index + 1) } }
            } catch { if first == nil { first = error }; next(index + 1) }
        }; next(0)
    }
    static func failure(_ code: String, _ text: String) -> GuguHostFailure { .init(code: code, message: text) }
}
