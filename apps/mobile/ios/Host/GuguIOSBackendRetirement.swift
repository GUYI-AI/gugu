import Foundation

extension GuguIOSNativeBackend {
    /// Local stop only. A sealed OwnerSession deliberately rejects ordinary
    /// credentials, so no ordinary heartbeat/lease/device HTTP is initiated here.
    func quiesceForRetirement(_ expected: GuguIOSHostBinding, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            if self.binding != expected {
                do { try self.lifecycle.stop(binding: expected); completion(.success(())) }
                catch { completion(.failure(error)) }
                return
            }
            self.sealForNativeRetirement()
            let group = DispatchGroup(); var first: Error?
            group.enter()
            if let scheduler = self.scheduler { scheduler.quiesce { result in self.queue.async {
                if case .failure(let error) = result { first = error }; group.leave()
            } } } else {
                do { try self.lifecycle.stop(binding: expected) } catch { first = error }; group.leave()
            }
            group.enter(); if let remote = self.remote { remote.close { group.leave() } } else { group.leave() }
            group.enter(); if self.heartbeatRunning { self.heartbeatWaiters.append { group.leave() } } else { group.leave() }
            group.notify(queue: self.queue) { completion(first.map { .failure($0) } ?? .success(())) }
        }
    }
}
