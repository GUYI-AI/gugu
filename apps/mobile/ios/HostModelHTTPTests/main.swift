import Foundation

private func require(_ value: @autoclosure () throws -> Bool, _ text: String) throws {
    if try !value() { throw GuguHostFailure(code: "model_http_test_failed", message: text) }
}
private final class Task: GuguModelHTTPTask {
    private let run: () -> Void
    private let stopped: () -> Void
    var resumes = 0, cancellations = 0
    init(run: @escaping () -> Void, stopped: @escaping () -> Void = {}) { self.run = run; self.stopped = stopped }
    func resume() { resumes += 1; run() }
    func cancel() { cancellations += 1; stopped() }
}
private struct Fixture {
    let owner = UUID().uuidString.lowercased(), agent = UUID().uuidString.lowercased(), session = UUID().uuidString.lowercased()
    let secret = "synthetic-short-lease-credential"
    var context: GuguHostContext { .init(ownerId: owner, installationId: UUID().uuidString.lowercased(), agentUserId: agent, sessionId: session, jobId: UUID().uuidString.lowercased(), contextEpoch: UUID().uuidString.lowercased(), runtimeInstanceId: UUID().uuidString.lowercased()) }
    var lease: GuguNativeModelLease { .init(ownerId: owner, agentUserId: agent, sessionId: session, modelId: "synthetic-wire-model", completionsURL: URL(string: "https://model.invalid/private-relay/v1/chat/completions")!, bearerToken: secret, expiresAt: Date().addingTimeInterval(3600)) }
    var request: [String: Any] { ["model": "synthetic-wire-model", "stream": false, "messages": [["role": "user", "content": "Synthetic native test"]]] }
}
@main struct HostModelHTTPTests {
    static func main() throws {
        let f = Fixture(); var cases: [String] = []
        func exercise(_ status: Int, _ bytes: Data?, _ headers: [String: String] = [:]) throws -> ([String: Any], [GuguModelHTTPDiagnostic]) {
            var reply: [String: Any]?, diagnostics: [GuguModelHTTPDiagnostic] = [], resumed = 0
            let transport = try GuguModelTransport(lease: f.lease, diagnostic: { diagnostics.append($0) }, send: { request, done in
                Task(run: { resumed += 1; done(bytes, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers), nil) })
            })
            transport.complete(id: UUID().uuidString.lowercased(), context: f.context, body: f.request) { reply = $0 }
            try require(resumed == 1 && reply != nil, "Native injection did not send exactly once")
            return (reply!, diagnostics)
        }
        let body = try JSONSerialization.data(withJSONObject: ["error": ["code": "invalid_request_error", "message": "Do not export \(f.secret) or https://model.invalid/private-relay", "type": "provider_error"], "request": ["Authorization": "Bearer \(f.secret)"]])
        let (failed, diagnostics) = try exercise(400, body, ["X-Request-ID": "request-400-native-only", "Authorization": "Bearer \(f.secret)"])
        try require(failed["code"] as? String == "model_http_error" && failed["message"] as? String == "Model HTTP status 400", "Pi failure contract changed")
        try require(diagnostics == [.init(status: 400, serverErrorCode: "invalid_request_error", requestId: "request-400-native-only")], "Structured native HTTP diagnostic differs")
        let shown = String(decoding: try JSONSerialization.data(withJSONObject: diagnostics[0].fields), as: UTF8.self), jsc = String(decoding: try JSONSerialization.data(withJSONObject: failed), as: UTF8.self)
        try require(!shown.contains(f.secret) && !shown.contains("model.invalid") && !shown.contains("message") && !jsc.contains(f.secret) && !jsc.contains("invalid_request_error") && !jsc.contains("request-400-native-only"), "Body/URL/credential or native diagnostic leaked to Pi reply")
        cases.append("synthetic_400_exports_only_native_status_code_request_ID_and_preserves_Pi_error")
        let reflected = try JSONSerialization.data(withJSONObject: ["error": ["code": f.secret, "message": f.secret], "request_id": "reflected-\(f.secret)"])
        let (_, redacted) = try exercise(400, reflected, ["x-request-id": f.secret])
        try require(redacted == [.init(status: 400, serverErrorCode: nil, requestId: nil)], "Reflected short credential escaped field filter")
        cases.append("known_lease_credential_is_rejected_in_body_code_and_request_ID_fields")
        let (_, malformed) = try exercise(400, Data("<html>\(f.secret) https://model.invalid</html>".utf8), ["x-request-id": "req-html"])
        try require(malformed == [.init(status: 400, serverErrorCode: nil, requestId: "req-html")], "Malformed body was exported or lost safe header ID")
        let large = Data(("{\"code\":\"must_not_parse\",\"padding\":\"" + String(repeating: "x", count: 70000) + "\"}").utf8)
        let (_, bounded) = try exercise(400, large, ["request-id": "req-large"])
        try require(bounded == [.init(status: 400, serverErrorCode: nil, requestId: "req-large")], "Oversized error body was parsed")
        cases.append("malformed_and_over_64KiB_bodies_never_escape_the_native_parser")
        let invalid = try JSONSerialization.data(withJSONObject: ["error": ["code": "invalid code with whitespace", "request_id": "https://model.invalid/secret"]])
        let (_, invalidFields) = try exercise(400, invalid, ["x-request-id": String(repeating: "r", count: 129)])
        try require(invalidFields == [.init(status: 400, serverErrorCode: nil, requestId: nil)], "Non-machine or overlong diagnostic fields were exported")
        let numeric = try JSONSerialization.data(withJSONObject: ["code": 400])
        let (_, number) = try exercise(400, numeric)
        try require(number.first?.serverErrorCode == "400", "Numeric server error code was lost")
        let boolean = try JSONSerialization.data(withJSONObject: ["code": true])
        let (_, boolCode) = try exercise(400, boolean)
        try require(boolCode.first?.serverErrorCode == nil, "Boolean error field became a server code")
        cases.append("diagnostic_machine_fields_have_strict_length_format_and_scalar_checks")
        for ending in ["\n", "\r\n", "\r", "\u{0085}", "\u{2028}", "\u{2029}"] {
            let terminated = try JSONSerialization.data(withJSONObject: ["error": ["code": "invalid_request" + ending], "request_id": "request-id" + ending])
            let (_, rejected) = try exercise(400, terminated)
            try require(rejected == [.init(status: 400, serverErrorCode: nil, requestId: nil)], "A final line terminator escaped whole-value field checks")
        }
        cases.append("LF_CRLF_CR_and_Unicode_line_terminators_are_rejected_without_trimming")
        for (codeLength, idLength, valid) in [(0, 0, false), (1, 1, true), (96, 128, true), (97, 129, false)] {
            let code = String(repeating: "a", count: codeLength), request = String(repeating: "b", count: idLength)
            let boundary = try JSONSerialization.data(withJSONObject: ["code": code, "request_id": request])
            let (_, checked) = try exercise(400, boundary)
            try require(checked == [.init(status: 400, serverErrorCode: valid ? code : nil, requestId: valid ? request : nil)], "Diagnostic field length boundary differs")
        }
        cases.append("machine_field_empty_minimum_maximum_and_overflow_lengths_are_exact")
        let (success, noDiagnostic) = try exercise(200, try JSONSerialization.data(withJSONObject: ["choices": []]))
        try require(success["ok"] as? Bool == true && noDiagnostic.isEmpty, "Successful reply emitted a failure diagnostic")
        cases.append("success_does_not_emit_failure_diagnostics")
        var cancelled: [String: Any]?, cancelledDiagnostics: [GuguModelHTTPDiagnostic] = [], held: Task?
        let transport = try GuguModelTransport(lease: f.lease, diagnostic: { cancelledDiagnostics.append($0) }, send: { _, done in
            let task = Task(run: {}, stopped: { done(nil, nil, URLError(.cancelled)) }); held = task; return task
        })
        let id = UUID().uuidString.lowercased()
        transport.complete(id: id, context: f.context, body: f.request) { cancelled = $0 }
        transport.cancel(id: id)
        try require(held?.resumes == 1 && held?.cancellations == 1 && cancelled?["code"] as? String == "cancelled" && cancelledDiagnostics.isEmpty, "Exact native cancellation changed under injected transport")
        cases.append("injected_native_transport_preserves_exact_cancellation_without_HTTP_replay")
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["result": "pass", "kind": "native_model_HTTP_diagnostics_with_synthetic_transport", "cases": cases, "realCloudHTTPCalls": 0, "realModelCalls": 0, "iosAppRuns": 0], options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
    }
}
