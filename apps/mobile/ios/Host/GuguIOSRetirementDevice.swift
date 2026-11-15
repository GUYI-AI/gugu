import Foundation

extension GuguIOSRetirementCleanup {
    func cleanDevice(_ store: GuguIOSBackendStore, _ id: String, _ http: GuguIOSRetirementHTTP, completion: @escaping (Error?) -> Void) {
        do {
            if try plan(store, id)["deviceConfirmed"] as? Bool == true { completion(nil); return }
            http.perform(.readOwnedDevice) { response in self.queue.async {
                do {
                    guard let rows = try response.get() as? [[String: Any]], rows.count <= 1 else { throw Self.failure("cleanup_protocol_error", "Device cleanup did not return one owned row list") }
                    guard let row = rows.first else { try self.confirmDevice(store, id); completion(nil); return }
                    guard row["device_id"] as? String == store.binding.deviceId, row["user_id"] as? String == store.binding.ownerId,
                          let existing = row["capabilities"] as? [String: Any], existing["host_kind"] as? String == "phone",
                          let version = row["updated_at"] as? String, Self.timestamp(version) != nil else { throw Self.failure("stale_context", "Device cleanup row belongs to another host or has no CAS version") }
                    var plan = try self.plan(store, id)
                    if let rawCAS = plan["deviceCAS"] {
                        guard let cas = rawCAS as? [String: Any], let before = cas["before"] as? String, let after = cas["after"] as? String,
                              let original = cas["originalCapabilities"] as? [String: Any], let wanted = cas["capabilities"] as? [String: Any] else { throw Self.failure("invalid_journal", "Original device cleanup CAS is unreadable") }
                        if Self.sameTimestamp(version, after), try GuguHostJournal.digest(existing) == GuguHostJournal.digest(wanted) {
                            try self.confirmDevice(store, id); completion(nil); return
                        }
                        guard Self.sameTimestamp(version, before), try GuguHostJournal.digest(existing) == GuguHostJournal.digest(original) else { throw Self.failure("cleanup_device_conflict", "Original device registration was replaced; it was not withdrawn") }
                    } else {
                        var capabilities = existing; capabilities["runtimes"] = []; capabilities["host_runtime_capability"] = 0
                        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                        var after = formatter.string(from: Date())
                        if Self.sameTimestamp(version, after) { after = formatter.string(from: Date().addingTimeInterval(0.001)) }
                        plan["deviceCAS"] = ["before": version, "after": after, "originalCapabilities": existing, "capabilities": capabilities]
                        try store.update("requests", id: "retirement:\(id)") { $0 = plan }
                    }
                    http.perform(.withdrawOwnedDevice, known: { raw in
                        guard let rows = raw as? [[String: Any]], rows.count == 1, rows[0]["device_id"] as? String == store.binding.deviceId else { throw Self.failure("cleanup_device_conflict", "Device did not confirm original capability withdrawal") }
                        try self.confirmDevice(store, id)
                    }) { result in self.queue.async {
                        switch result { case .success: completion(nil); case .failure(let error): completion(error) }
                    } }
                } catch { completion(error) }
            } }
        } catch { completion(error) }
    }
    private func confirmDevice(_ store: GuguIOSBackendStore, _ id: String) throws {
        try store.update("requests", id: "retirement:\(id)") { $0["deviceConfirmed"] = true }
    }
    private static func timestamp(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]; return formatter.date(from: value)
    }
    private static func sameTimestamp(_ left: String, _ right: String) -> Bool {
        guard let lhs = timestamp(left), let rhs = timestamp(right) else { return false }; return abs(lhs.timeIntervalSince(rhs)) < 0.000001
    }
}
