import Foundation

/// Native integration driver for the existing broker + Pi path. This is absent
/// from GuguAgent's JS method list and cannot enable advertised host capability.
/// A supplies the App-owned service and real owner UI; no credential is returned.
final class GuguIOSHostProbe {
    private let service: GuguIOSHostService
    private let binding: GuguIOSHostBinding
    init(service: GuguIOSHostService, expectedBinding: GuguIOSHostBinding) throws {
        try service.backend.check(expectedBinding)
        self.service = service; binding = expectedBinding
    }
    func deepSeekV4Pro(completion: @escaping (Result<String, Error>) -> Void) {
        service.backend.broker.catalog(binding: binding) { response in
            completion(response.flatMap { rows in Result {
                let matches = rows.filter { $0["display_name"] as? String == "DeepSeek V4 Pro" }
                guard matches.count == 1, let id = matches[0]["id"] as? String, !id.isEmpty else {
                    throw GuguHostFailure(code: "model_unavailable", message: "Catalog did not return exactly one enabled DeepSeek V4 Pro")
                }
                return id
            } })
        }
    }
    /// Use the original UUID again after a timeout. Provision, create-command,
    /// native session and initial input IDs retain their durable phase custody.
    func create(requestId: String, prompt: String, completion: @escaping ([String: Any]) -> Void) {
        deepSeekV4Pro { response in
            do {
                let id = try response.get()
                self.invoke(requestId, "sessionTimeline.sessionCreate", [["clientRequestId": requestId, "prompt": prompt,
                    "title": "iPhone native broker verification", "harness": "pi", "transport": "acp", "sessionView": "general", "model": "platform:\(id)"]], completion)
            } catch { completion(GuguIOSNativeBackend.replyError(error)) }
        }
    }
    func snapshot(requestId: String, sessionId: String, completion: @escaping ([String: Any]) -> Void) {
        invoke(requestId, "sessionTimeline.sessionSnapshot", [["conversationId": sessionId, "trim": false]], completion)
    }
    func respond(requestId: String, sessionId: String, itemId: String, optionId: String, completion: @escaping ([String: Any]) -> Void) {
        invoke(requestId, "sessionTimeline.sessionRespond", [["conversationId": sessionId, "kind": "permission", "itemId": itemId, "optionId": optionId]], completion)
    }
    private func invoke(_ id: String, _ channel: String, _ args: [Any], _ completion: @escaping ([String: Any]) -> Void) {
        do {
            try service.backend.check(binding)
            guard UUID(uuidString: id) != nil else { throw GuguHostFailure(code: "invalid_args", message: "Original native probe UUID is required") }
            service.backend.invoke(.init(binding: binding, requestId: id, channel: channel, arguments: args, origin: .localOwnerUI), completion: completion)
        } catch { completion(GuguIOSNativeBackend.replyError(error, admission: "rejected")) }
    }
}
