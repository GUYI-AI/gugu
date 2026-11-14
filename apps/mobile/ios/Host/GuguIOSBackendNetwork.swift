import Foundation

extension GuguIOSNativeBackend {
    func heartbeat() {
        guard !stopped, !heartbeatRunning, let expected = binding else { return }
        heartbeatRunning = true; let epoch = generation
        func finish(_ error: Error?) {
            heartbeatRunning = false
            if generation == epoch, !stopped {
                heartbeatError = error; heartbeatHealthy = error == nil
                if error == nil { heartbeatAt = Date(); commandTick(); inboxTick() }
                publish()
            }
            let waiters = heartbeatWaiters; heartbeatWaiters.removeAll(); for waiter in waiters { waiter() }
        }
        do { try check(expected) } catch { finish(error); return }
        broker.perform(.heartbeat(instanceId: instanceId), binding: expected) { result in self.queue.async {
            do {
                _ = try result.get(); try self.check(expected)
                guard !self.stopped, self.generation == epoch else { finish(nil); return }
                let now = ISO8601DateFormatter().string(from: Date())
                let available = self.startupComplete && self.remoteConnected && self.missingDelivery == nil
                    && self.healthError == nil && self.commandError == nil && self.scheduler?.healthFailure() == nil
                var capabilities: [String: Any] = ["terminals": [], "runtimes": available ? ["pi"] : [], "host_runtime_capability": available ? 1 : 0,
                    "host_kind": "phone", "os_name": self.metadata["osName"]!, "remote_protocol": self.remoteProtocol, "min_client_protocol": self.minimumClientProtocol,
                    "actions": ["v": 1, "actions": []]]
                if let version = self.metadata["appVersion"] as? String { capabilities["app_version"] = version }
                let row: [String: Any] = ["device_id": expected.deviceId, "user_id": expected.ownerId, "label": self.metadata["label"]!, "hostname": self.metadata["hostname"]!,
                    "machine_id": expected.installationId, "platform": "ios", "tier": self.metadata["tier"]!, "status": "online", "last_seen_at": now, "updated_at": now, "capabilities": capabilities]
                self.broker.perform(.registerDevice(row), binding: expected) { result in self.queue.async {
                    do { _ = try result.get(); finish(nil) } catch { finish(error) }
                } }
            } catch { finish(error) }
        } }
    }
    func armHeartbeat() {
        heartbeatTimer?.cancel()
        let work = DispatchWorkItem { [weak self] in guard let self, !self.stopped else { return }; self.heartbeat(); self.armHeartbeat() }
        heartbeatTimer = work; queue.asyncAfter(deadline: .now() + 30, execute: work)
    }
    func withdraw(_ expected: GuguIOSHostBinding, completion: @escaping (Result<Void, Error>) -> Void) {
        broker.perform(.readDevice, binding: expected) { result in
            do {
                guard let rows = try result.get() as? [[String: Any]] else { throw Self.failure("cloud_protocol_error", "Device read returned no owned row list") }
                guard let row = rows.first else { completion(.success(())); return }
                guard row["device_id"] as? String == expected.deviceId, row["user_id"] as? String == expected.ownerId,
                      var capabilities = row["capabilities"] as? [String: Any], capabilities["host_kind"] as? String == "phone" else { throw Self.failure("stale_context", "Device capability belongs to another native host") }
                capabilities["runtimes"] = []; capabilities["host_runtime_capability"] = 0
                self.broker.perform(.withdrawDevice(capabilities), binding: expected) { result in
                    completion(result.flatMap { raw in Result {
                        guard let rows = raw as? [[String: Any]], rows.count == 1, rows[0]["device_id"] as? String == expected.deviceId else { throw Self.failure("cloud_protocol_error", "Device did not confirm native capability withdrawal") }
                    } })
                }
            } catch { completion(.failure(error)) }
        }
    }
    func recoverLeases(_ expected: GuguIOSHostBinding, completion: @escaping (Result<Void, Error>) -> Void) {
        do {
            let rows = try store?.snapshot()["leases"] as? [String: [String: Any]] ?? [:]
            let pending = rows.filter { $0.value["status"] as? String != "settled" }
            var first: Error?
            let known = pending.compactMap { key, row -> (String, String)? in
                guard let id = row["leaseId"] as? String else { if first == nil { first = Self.failure("model_issue_uncertain", "An earlier model issue has no known lease ID; it will not be repeated") }; return nil }
                return (key, id)
            }
            func next(_ index: Int) {
                guard index < known.count else { completion(first.map { .failure($0) } ?? .success(())); return }
                let (key, lease) = known[index]
                broker.settleModel(binding: expected, leaseId: lease) { result in self.queue.async {
                    do { _ = try result.get(); try self.store?.update("leases", id: key) { $0["status"] = "settled" } }
                    catch { if first == nil { first = error } }
                    next(index + 1)
                } }
            }
            next(0)
        } catch { completion(.failure(error)) }
    }
    func commandTick() {
        guard !stopped, !commandRunning, let expected = binding else { return }
        commandRunning = true; let epoch = generation
        func finish(_ error: Error?) {
            guard generation == epoch else { return }
            commandRunning = false
            if !stopped { commandError = error; publish() }
        }
        func fetch() {
            broker.perform(.pendingCommands(perAgent: 5), binding: expected) { result in self.queue.async {
                do {
                    try self.check(expected); guard self.generation == epoch, !self.stopped else { finish(nil); return }
                    guard let rows = try result.get() as? [[String: Any]] else { throw Self.failure("cloud_protocol_error", "Pending native commands are not an array") }
                    func next(_ index: Int) {
                        guard index < rows.count else { finish(nil); return }
                        guard let id = rows[index]["id"] as? String else {
                            finish(Self.failure("cloud_protocol_error", "Native command has no original ID")); return
                        }
                        let completed: (Result<Void, Error>) -> Void = { result in self.queue.async {
                            do { _ = try result.get(); self.inboxTick(); next(index + 1) } catch { finish(error) }
                        } }
                        if rows[index]["type"] as? String == "agent.create", let create = self.createCommand {
                            create.execute(id: id, completion: completed)
                        } else if rows[index]["type"] as? String == "agent.deliver", let delivery = self.deliveryCommand {
                            delivery.execute(id: id, completion: completed)
                        } else {
                            finish(Self.failure("unsupported", "Native device command requires its delivery adapter")); return
                        }
                    }
                    next(0)
                } catch { finish(error) }
            } }
        }
        if recoveredCommands { fetch() }
        else {
            broker.perform(.recoverCommands, binding: expected) { result in self.queue.async {
                do {
                    guard let count = try result.get() as? Int, count >= 0 else { throw Self.failure("cloud_protocol_error", "Orphan recovery returned no count") }
                    try self.check(expected); guard self.generation == epoch, !self.stopped else { finish(nil); return }
                    self.recoveredCommands = true; fetch()
                } catch { finish(error) }
            } }
        }
    }
    func inboxTick() {
        guard !stopped, !inboxRunning, let expected = binding, let inbox else { return }
        inboxRunning = true; let epoch = generation
        do {
            let agents = try records().filter { $0["status"] as? String != "archived" }.compactMap { $0["agentUserId"] as? String }.sorted()
            var first: Error?
            func next(_ index: Int) {
                guard generation == epoch, !stopped else { return }
                guard index < agents.count else {
                    let changed = self.inboxHealthy != (first == nil)
                    self.inboxRunning = false; self.inboxHealthy = first == nil; self.inboxError = first
                    self.publish()
                    // Publish/withdraw the actual capability after reconciliation.
                    if changed { self.heartbeat() }
                    return
                }
                inbox.pull(agentId: agents[index]) { result in self.queue.async {
                    guard self.generation == epoch, !self.stopped else { return }
                    do { _ = try result.get(); try self.check(expected) } catch { if first == nil { first = error } }
                    next(index + 1)
                } }
            }
            next(0)
        } catch { inboxRunning = false; inboxHealthy = false; inboxError = error; publish() }
    }
}
