import Foundation

/// Native short-lease lifecycle for one registered session. Human authentication
/// remains outside this class. An uncertain issue is never issued again.
final class GuguIOSLeaseModel: GuguModelCompleting {
    private struct Pending {
        let context: GuguHostContext
        let body: [String: Any]
        let done: ([String: Any]) -> Void
    }
    private let queue = DispatchQueue(label: "app.gugu.ios.model-lease")
    private let binding: GuguIOSHostBinding
    private let agentId: String
    private let sessionId: String
    private var modelId: String
    private let broker: GuguIOSCloudBroker
    private let store: GuguIOSBackendStore
    private let check: () throws -> Void
    private let makeTransport: (GuguNativeModelLease) throws -> GuguModelCompleting
    private var grant: GuguIOSModelGrant?
    private var grantJobId: String?
    private var issuingJobId: String?
    private var requests: [String: Pending] = [:]
    private var transports: [String: GuguModelCompleting] = [:]
    private var seen: Set<String> = []
    private var stopped = false
    private var renewal: DispatchWorkItem?
    private var settlementWaiters: [(Result<Void, Error>) -> Void] = []

    init(binding: GuguIOSHostBinding, agentId: String, sessionId: String, modelId: String, broker: GuguIOSCloudBroker,
         store: GuguIOSBackendStore, check: @escaping () throws -> Void,
         makeTransport: @escaping (GuguNativeModelLease) throws -> GuguModelCompleting = { try GuguModelTransport(lease: $0) }) {
        self.binding = binding; self.agentId = agentId; self.sessionId = sessionId; self.modelId = modelId
        self.broker = broker; self.store = store; self.check = check; self.makeTransport = makeTransport
    }

    func complete(id: String, context: GuguHostContext, body: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            do {
                try self.check()
                guard !self.stopped, context.ownerId == self.binding.ownerId, context.installationId == self.binding.installationId,
                      context.agentUserId == self.agentId, context.sessionId == self.sessionId, body["model"] as? String == self.modelId else {
                    throw Self.failure("model_lease_mismatch", "Model request differs from the native session")
                }
                guard self.seen.insert(id).inserted else { throw Self.failure("duplicate_conflict", "Model request ID was already admitted") }
                guard self.grantJobId == nil || self.grantJobId == context.jobId, self.issuingJobId == nil || self.issuingJobId == context.jobId else {
                    throw Self.failure("session_busy", "Previous task model lease must settle before another turn")
                }
                self.requests[id] = Pending(context: context, body: body, done: completion)
                if let grant = self.grant { try self.send(id, grant); return }
                if self.issuingJobId != nil { return }
                let key = "issue:\(context.jobId)"
                var created = false
                _ = try self.store.admit("leases", id: key, fingerprint: GuguHostJournal.digest(["agentId": self.agentId, "sessionId": self.sessionId, "modelId": self.modelId, "jobId": context.jobId])) {
                    created = true
                    return ["status": "issuing", "agentId": self.agentId, "sessionId": self.sessionId, "jobId": context.jobId]
                }
                guard created else { throw Self.failure("model_issue_uncertain", "Original model issue needs reconciliation; it will not be repeated") }
                self.issuingJobId = context.jobId
                self.broker.issueModel(binding: self.binding, agentId: self.agentId, sessionId: self.sessionId, modelId: self.modelId, recordLease: { leaseId in
                    try self.store.update("leases", id: key) { $0["leaseId"] = leaseId; $0["status"] = "issued" }
                }) { result in self.queue.async {
                    self.issuingJobId = nil
                    switch result {
                    case .failure(let error):
                        try? self.store.update("leases", id: key) { $0["status"] = $0["leaseId"] == nil ? "issue_uncertain" : "cleanup_required" }
                        self.failRequests(jobId: context.jobId, error: error)
                    case .success(let grant):
                        self.grant = grant; self.grantJobId = context.jobId
                        if self.stopped || !self.requests.values.contains(where: { $0.context.jobId == context.jobId }) {
                            self.settleCurrent { _ in }; return
                        }
                        self.armRenewal()
                        for requestId in Array(self.requests.keys) {
                            do { try self.send(requestId, grant) } catch { self.finish(requestId, Self.envelope(error)) }
                        }
                    }
                } }
            } catch {
                if self.requests[id] != nil { self.finish(id, Self.envelope(error)) } else { completion(Self.envelope(error)) }
            }
        }
    }

    func selectModel(_ id: String, persist: @escaping () throws -> Void, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            do {
                try self.check()
                guard !self.stopped, !id.isEmpty, self.grant == nil, self.issuingJobId == nil, self.requests.isEmpty else { throw Self.failure("session_busy", "Current model lease must finish before changing selection") }
                let rows = try self.store.snapshot()["leases"] as? [String: [String: Any]] ?? [:]
                guard !rows.values.contains(where: { $0["agentId"] as? String == self.agentId && $0["sessionId"] as? String == self.sessionId && $0["status"] as? String != "settled" }) else { throw Self.failure("model_cleanup_pending", "Original model cleanup is still pending") }
                try persist(); self.modelId = id; completion(.success(()))
            } catch { completion(.failure(error)) }
        }
    }

    func cancel(id: String) {
        queue.async {
            self.transports[id]?.cancel(id: id)
            self.finish(id, Self.failure("cancelled", "Model request was cancelled").envelope)
        }
    }

    /// Task completion closes its original lease; another task cannot issue a
    /// replacement until that cleanup succeeds. No token is persisted on failure.
    func finishTurn(jobId: String, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            guard self.issuingJobId != jobId else { completion(.failure(Self.failure("model_issue_uncertain", "Model issue is still in flight"))); return }
            guard self.grantJobId == jobId else {
                do {
                    if let record = try self.store.record("leases", id: "issue:\(jobId)"), record["status"] as? String != "settled" {
                        throw Self.failure("model_cleanup_pending", "Original model issue or cleanup remains unresolved")
                    }
                    completion(.success(()))
                } catch { completion(.failure(error)) }
                return
            }
            self.settleCurrent(completion)
        }
    }
    func stop(completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            self.stopped = true; self.renewal?.cancel(); self.renewal = nil
            for (id, transport) in self.transports { transport.cancel(id: id) }
            for id in Array(self.requests.keys) { self.finish(id, Self.failure("cancelled", "Native model host stopped").envelope) }
            if self.issuingJobId != nil { completion(.failure(Self.failure("model_issue_uncertain", "Original issue must settle before retirement"))); return }
            self.settleCurrent(completion)
        }
    }

    private func send(_ id: String, _ grant: GuguIOSModelGrant) throws {
        try check()
        guard !stopped, grant.lease.expiresAt > Date(), let request = requests[id], transports[id] == nil else {
            throw Self.failure("model_lease_expired", "Native model request is unavailable or expired")
        }
        var wire = request.body; wire["model"] = grant.lease.modelId
        let transport = try makeTransport(grant.lease); transports[id] = transport
        transport.complete(id: id, context: request.context, body: wire) { reply in self.queue.async {
            do { try self.check(); self.finish(id, reply) }
            catch { self.finish(id, Self.envelope(error)) }
        } }
    }
    private func finish(_ id: String, _ reply: [String: Any]) {
        transports.removeValue(forKey: id)
        requests.removeValue(forKey: id)?.done(reply)
    }
    private func failRequests(jobId: String, error: Error) {
        for (id, request) in requests where request.context.jobId == jobId { finish(id, Self.envelope(error)) }
    }
    private func armRenewal() {
        renewal?.cancel()
        guard !stopped, let grant else { return }
        let work = DispatchWorkItem { [weak self] in self?.renew() }; renewal = work
        queue.asyncAfter(deadline: .now() + max(1, grant.lease.expiresAt.timeIntervalSinceNow - 120), execute: work)
    }
    private func renew() {
        guard !stopped, let grant else { return }
        broker.renewModel(binding: binding, grant: grant) { result in self.queue.async {
            guard !self.stopped, self.grant?.leaseId == grant.leaseId else { return }
            switch result {
            case .success(let next): self.grant = next; self.armRenewal()
            case .failure(let error):
                if grant.lease.expiresAt <= Date() {
                    for (id, transport) in self.transports { transport.cancel(id: id) }
                    self.failRequests(jobId: self.grantJobId ?? "", error: error)
                }
                else {
                    let work = DispatchWorkItem { [weak self] in self?.renew() }; self.renewal = work
                    self.queue.asyncAfter(deadline: .now() + min(15, grant.lease.expiresAt.timeIntervalSinceNow), execute: work)
                }
            }
        } }
    }
    private func settleCurrent(_ completion: @escaping (Result<Void, Error>) -> Void) {
        renewal?.cancel(); renewal = nil
        guard let grant, let jobId = grantJobId else {
            do {
                let rows = try store.snapshot()["leases"] as? [String: [String: Any]] ?? [:]
                guard !rows.values.contains(where: { $0["agentId"] as? String == agentId && $0["sessionId"] as? String == sessionId && $0["status"] as? String != "settled" }) else {
                    throw Self.failure("model_cleanup_pending", "Native model issue or cleanup still needs reconciliation")
                }
                completion(.success(()))
            } catch { completion(.failure(error)) }
            return
        }
        settlementWaiters.append(completion)
        guard settlementWaiters.count == 1 else { return }
        let finish: (Result<Void, Error>) -> Void = { result in
            let callbacks = self.settlementWaiters; self.settlementWaiters.removeAll()
            for callback in callbacks { callback(result) }
        }
        broker.settleModel(binding: binding, leaseId: grant.leaseId) { result in self.queue.async {
            do {
                _ = try result.get()
                try self.store.update("leases", id: "issue:\(jobId)") { $0["status"] = "settled" }
                self.grant = nil; self.grantJobId = nil; finish(.success(()))
            } catch {
                try? self.store.update("leases", id: "issue:\(jobId)") { $0["status"] = "cleanup_required" }
                finish(.failure(error))
            }
        } }
    }
    private static func failure(_ code: String, _ text: String) -> GuguHostFailure { GuguHostFailure(code: code, message: text) }
    private static func envelope(_ error: Error) -> [String: Any] { (error as? GuguHostFailure ?? failure("model_failed", "Native model lease operation failed")).envelope }
}
