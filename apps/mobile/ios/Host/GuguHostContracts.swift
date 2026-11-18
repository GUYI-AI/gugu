import Foundation

/// Every native operation is bound to one account, installation and exact task turn.
struct GuguHostContext: Codable, Equatable {
    let ownerId: String
    let installationId: String
    let agentUserId: String
    let sessionId: String
    let jobId: String
    let contextEpoch: String
    let runtimeInstanceId: String
}

/// Constructed by the native host, never accepted directly from model arguments.
struct GuguNativeToolRequest {
    let context: GuguHostContext
    let requestId: String
    let toolCallId: String
    let actionName: String
    let argumentsJSON: String
    let argumentsSHA256: String
    let deadlineAtMs: Int64
}

/// The executor must check immediately before accessing EventKit and after async waits.
/// beginMutation durably claims the exact, one-use native owner approval before an OS write.
/// A claimed write with no durable result becomes execution_unknown; it is never replayed.
final class GuguNativeToolControl {
    private let active: () throws -> Void
    private let mutation: () throws -> Void
    private let finish: ([String: Any]) throws -> Void

    init(checkActive: @escaping () throws -> Void, beginMutation: @escaping () throws -> Void,
         finishMutation: @escaping ([String: Any]) throws -> Void) {
        active = checkActive
        mutation = beginMutation
        finish = finishMutation
    }

    func checkActive() throws { try active() }
    func beginMutation() throws { try active(); try mutation() }
    /// Save the successful OS receipt data (without an ok/data envelope) before post-write checks.
    func finishMutation(_ data: [String: Any]) throws { try finish(data) }
}

protocol GuguNativeToolExecutor: AnyObject {
    /// Required before returning any saved receipt or protected task transcript.
    func validateAccess(_ control: GuguNativeToolControl) throws

    /// Complete once with the device-action envelope: ok/data or ok:false/code/message.
    /// Invocation does not request OS permission. Connection is an explicit native owner UI action.
    func execute(_ request: GuguNativeToolRequest, control: GuguNativeToolControl,
                 completion: @escaping ([String: Any]) -> Void)
}

struct GuguHostFailure: Error {
    let code: String
    let message: String
    var envelope: [String: Any] { ["ok": false, "code": code, "message": message] }
}
