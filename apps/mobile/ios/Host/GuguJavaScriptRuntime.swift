import Foundation
import JavaScriptCore
import CryptoKit

struct GuguBridgeRequest {
    let id: String
    let method: String
    let payload: [String: Any]
}

/// One serial JSC context in the App process. Native requests are asynchronous;
/// all JSValue use, including late callbacks, returns to this same queue.
final class GuguJavaScriptRuntime {
    typealias Reply = ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "app.gugu.ios.agent.javascript")
    private let queueKey = DispatchSpecificKey<Bool>()
    private var context: JSContext!
    private let requestHandler: (GuguBridgeRequest, @escaping Reply) -> Void
    private let cancelHandler: (String) -> Void
    private let eventHandler: ([String: Any]) -> Void
    private var scriptError: String?
    private var projections: [String: Reply] = [:]
    let assetSHA256: String

    init(asset: Data, expectedSHA256: String,
         request: @escaping (GuguBridgeRequest, @escaping Reply) -> Void,
         cancel: @escaping (String) -> Void, event: @escaping ([String: Any]) -> Void) throws {
        let digest = SHA256.hash(data: asset).map { String(format: "%02x", $0) }.joined()
        guard digest == expectedSHA256, let script = String(data: asset, encoding: .utf8) else {
            throw GuguHostFailure(code: "invalid_runtime_asset", message: "Packaged runtime digest or encoding mismatch")
        }
        assetSHA256 = digest
        requestHandler = request
        cancelHandler = cancel
        eventHandler = event
        queue.setSpecific(key: queueKey, value: true)
        queue.sync {
            context = JSContext()
            context.exceptionHandler = { [weak self] _, value in
                self?.scriptError = value?.toString() ?? "Unknown JavaScript exception"
            }
            let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
            let encode: @convention(block) (String) -> String = { value in
                "[" + value.utf8.map { String($0) }.joined(separator: ",") + "]"
            }
            let clock: @convention(block) () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
            let nativeRequest: @convention(block) (String, String, String) -> Void = { [weak self] id, method, json in
                guard let self else { return }
                do {
                    let payload = try Self.object(json)
                    self.requestHandler(GuguBridgeRequest(id: id, method: method, payload: payload)) { [weak self] reply in
                        self?.settle(id, reply)
                    }
                } catch {
                    self.settle(id, ["ok": false, "code": "invalid_args", "message": "Invalid bridge request JSON"])
                }
            }
            let nativeCancel: @convention(block) (String) -> Void = { [weak self] id in self?.cancelHandler(id) }
            let nativeEvent: @convention(block) (String) -> Void = { [weak self] json in
                guard let self else { return }
                do { self.eventHandler(try Self.object(json)) }
                catch { self.eventHandler(["type": "host_error", "message": "Invalid runtime event JSON"]) }
            }
            let nativeProjection: @convention(block) (String, String) -> Void = { [weak self] id, json in
                guard let self, let completion = self.projections.removeValue(forKey: id) else { return }
                do { completion(try Self.object(json)) }
                catch { completion(["ok": false, "code": "record_unreadable", "message": "Invalid native timeline result"]) }
            }
            context.setObject(uuid, forKeyedSubscript: "__guguUUID" as NSString)
            context.setObject(encode, forKeyedSubscript: "__guguUTF8Encode" as NSString)
            context.setObject(clock, forKeyedSubscript: "__guguMonotonic" as NSString)
            context.setObject(nativeRequest, forKeyedSubscript: "__guguNativeRequest" as NSString)
            context.setObject(nativeCancel, forKeyedSubscript: "__guguNativeCancel" as NSString)
            context.setObject(nativeEvent, forKeyedSubscript: "__guguNativeEvent" as NSString)
            context.setObject(nativeProjection, forKeyedSubscript: "__guguNativeProjection" as NSString)
            context.evaluateScript(script, withSourceURL: URL(string: "gugu-bundle://HostRuntime/agent.js"))
        }
        if let scriptError { throw GuguHostFailure(code: "runtime_load_failed", message: scriptError) }
    }

    func diagnostics() throws -> [String: Any] {
        try queue.sync {
            guard let json = context.objectForKeyedSubscript("GuguIOSRuntime")?.invokeMethod("diagnostics", withArguments: [])?.toString() else {
                throw GuguHostFailure(code: "runtime_not_ready", message: scriptError ?? "Runtime export is missing")
            }
            var result = try Self.object(json)
            result["pid"] = ProcessInfo.processInfo.processIdentifier
            result["assetSHA256"] = assetSHA256
            result["bundleId"] = Bundle.main.bundleIdentifier ?? NSNull()
            return result
        }
    }

    func start(_ command: [String: Any]) throws {
        let json = try Self.json(command)
        queue.async { [weak self] in
            guard let self else { return }
            self.context.objectForKeyedSubscript("GuguIOSRuntime")?.invokeMethod("start", withArguments: [json])
            self.reportException()
        }
    }

    /// Native backend only: input must come from authorized journal reads. The
    /// caller rechecks identity/category again before delivering this async view.
    func readTimeline(_ input: [String: Any], completion: @escaping Reply) throws {
        let json = try Self.json(input)
        let id = UUID().uuidString.lowercased()
        queue.async { [weak self] in
            guard let self else { return }
            self.projections[id] = completion
            self.context.objectForKeyedSubscript("GuguIOSRuntime")?.invokeMethod("timeline", withArguments: [id, json])
            if let message = self.scriptError {
                self.scriptError = nil
                self.projections.removeValue(forKey: id)?(["ok": false, "code": "record_unreadable", "message": message])
            }
        }
        queue.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.projections.removeValue(forKey: id)?(["ok": false, "code": "record_unreadable", "message": "Native timeline projection timed out"])
        }
    }

    @discardableResult func cancel(_ binding: GuguHostContext) throws -> Bool {
        let data = try JSONEncoder().encode(binding)
        let json = String(decoding: data, as: UTF8.self)
        let cancel = {
            self.context.objectForKeyedSubscript("GuguIOSRuntime")?.invokeMethod("cancel", withArguments: [json])?.toBool() == true
        }
        if DispatchQueue.getSpecific(key: queueKey) == true { return cancel() }
        return queue.sync(execute: cancel)
    }

    /// Native inbox only: a picked cloud row, identity/rules facts and no token.
    /// The caller must persist its admitted input before advancing read receipts.
    func readDelivery(_ input: [String: Any], completion: @escaping Reply) throws {
        try GuguIOSCloudBroker.rejectCredentials(input)
        let json = try Self.json(input), id = UUID().uuidString.lowercased()
        queue.async { [weak self] in
            guard let self else { return }
            self.projections[id] = completion
            self.context.objectForKeyedSubscript("GuguIOSRuntime")?.invokeMethod("delivery", withArguments: [id, json])
            if let message = self.scriptError {
                self.scriptError = nil
                self.projections.removeValue(forKey: id)?(["ok": false, "code": "delivery_invalid", "message": message])
            }
        }
        queue.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.projections.removeValue(forKey: id)?(["ok": false, "code": "delivery_invalid", "message": "Native inbox projection timed out"])
        }
    }

    func cancelAsynchronously(_ binding: GuguHostContext) throws {
        let json = String(decoding: try JSONEncoder().encode(binding), as: UTF8.self)
        queue.async { [weak self] in
            self?.context.objectForKeyedSubscript("GuguIOSRuntime")?.invokeMethod("cancel", withArguments: [json])
        }
    }

    private func settle(_ id: String, _ reply: [String: Any]) {
        let json: String
        do { json = try Self.json(reply) }
        catch { json = "{\"ok\":false,\"code\":\"invalid_native_result\",\"message\":\"Native result is not JSON\"}" }
        queue.async { [weak self] in
            guard let self else { return }
            self.context.objectForKeyedSubscript("GuguIOSRuntime")?.invokeMethod("settle", withArguments: [id, json])
            self.reportException()
        }
    }

    private func reportException() {
        if let message = scriptError {
            scriptError = nil
            eventHandler(["type": "host_error", "message": message])
        }
    }

    static func object(_ json: String) throws -> [String: Any] {
        guard let data = json.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GuguHostFailure(code: "invalid_args", message: "Expected a JSON object")
        }
        return value
    }

    static func json(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])
        return String(decoding: data, as: UTF8.self)
    }
}
