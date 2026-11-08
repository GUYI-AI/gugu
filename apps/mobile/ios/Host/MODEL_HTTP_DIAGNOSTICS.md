# Native model HTTP failure diagnostics

Refs #1877. This is an additive native observer, not a model retry or a new JS API.
The existing Pi failure remains `model_http_error` with `Model HTTP status N`.
The response body, URL, headers, message and request payload are never returned
through the diagnostic interface or added to the Pi/JSC response/journal.

Inject the observer through the already frozen service factory:

```swift
modelTransport: { lease in
    try GuguModelTransport(lease: lease, diagnostic: { diagnostic in
        // A decides where to keep this explicit native-only evidence.
        recordNativeHTTPFacts(diagnostic.fields)
    })
}
```

`GuguModelHTTPDiagnostic` has exactly `status: Int`, `serverErrorCode: String?`,
`requestId: String?`. Its fields dictionary omits absent optional facts. An
observer is called only for a completed non-2xx HTTP response; construction,
success, cancellation and transport failures do not emit HTTP failure facts.
There is no automatic persistence or retry, and neither credentials nor a URL
is an observer argument. A supplies the original verified service and decides
whether a later diagnostic turn is authorized within the existing model budget.

The parser reads at most 64 KiB as a structured JSON error. It picks only
error.code, error_code, code, then error.type; integral numeric codes are accepted,
booleans are rejected. String codes are at most 96 ASCII machine characters.
Request IDs are at most 128 ASCII letters/digits/underscore/hyphen, selected from
x-request-id, request-id, x-amzn-requestid, cf-ray, then structured request_id.
Whitespace, URLs, overlong fields, JWT/API-key shapes and values containing the
known native short credential or relay hostname are omitted. Error messages,
raw HTML/JSON and other response fields never leave the parser. These are
untrusted service facts, not instructions or proof that a model turn succeeded.

`GuguModelTransport.Send` returns a native GuguModelHTTPTask (resume/cancel) and
exists for deterministic offline transport injection. The default remains
URLSessionDataTask with the same no-redirect/no-cookie/no-cache behavior and
exact request cancellation. The test driver uses synthetic HTTP 400, malformed
and oversized bodies, credential reflections, invalid fields, success and
cancellation; it performs zero actual HTTP/model calls. Native observer tests
do not prove a real provider response, billing settlement, JSC or iOS App run.
