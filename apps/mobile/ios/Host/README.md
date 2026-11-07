# In-process phone host

Refs #1877. This slice runs the packaged JavaScript with Apple's JavaScriptCore in the App process. It must not spawn Node or delegate the agent loop to a remote host. Remote model inference is a network transport, while the Pi loop, native tools, cancellation and journal remain local.

## Boundary v1

`GuguHostContracts.swift` defines the native calendar boundary. Each request includes `ownerId`, `installationId`, `agentUserId`, `sessionId`, `jobId`, `contextEpoch`, `runtimeInstanceId`, `requestId`, `toolCallId`, `actionName`, canonical `argumentsJSON`, its SHA-256 and a native deadline. Identifiers and current account/installation are validated by the host before dispatch. The model cannot supply approval or identity fields.

The native executor receives a `GuguNativeToolControl`. It calls `checkActive()` immediately before a read, after an async wait and before returning protected data. For create/update/delete it calls `beginMutation()` immediately before the EventKit write. This synchronously validates cancellation, expiry, current identity and permission context, then durably claims the exact one-use approval. After the OS write, it calls `finishMutation(result)` before any post-write permission/cancellation check. This preserves a known outcome even when its protected data can no longer be delivered. The executor completes once with the existing device-action result envelope. It never requests OS permission while executing a tool.

Approval comes only from the owner's local native task UI. It binds the complete context, request ID, tool-call ID, action and canonical argument digest; it expires and cannot authorize a second call. Neither a JSON `confirmed` field nor an agent message is approval. Category and OS permissions remain the calendar executor's authority and are checked on every access.

Cancellation targets the exact context, including job and runtime instance. Late callbacks may record a known write result, but cannot deliver protected content into another account or newer turn. The journal records tool admission before dispatch, a mutation claim before the OS write, then the receipt before acknowledging completion. Duplicate IDs with changed arguments are rejected. Repeated completed calls return the saved receipt only after current permissions are checked. A mutation claim without a saved receipt is `execution_unknown` after interruption; recovery never replays it. Queued reads can be retried only through explicit task continuation.

## First executable slice

1. Bundle the existing pinned Pi agent core with an injected native model stream function; no coding-agent filesystem loader or CLI tools.
2. Evaluate that exact asset in a Swift-owned JSC context on one serial queue. Export narrow JSON callbacks for clock/UUID, model transport, journal, tool dispatch and events. No general filesystem or eval/download entry point.
3. Use native URLSession for the model protocol selected by the authenticated model lease. Tokens remain ephemeral in native memory. No model request runs before a real assigned identity and budget receipt are available.
4. Run the packaged asset with a native read callback, persist its real events, cancel an outstanding operation and restart from the saved journal. Offline fixtures exercise bridge/state boundaries only and are never evidence of a real model or EventKit result.
5. Build and exercise the same files in an iOS simulator through the normal App target, then independently rerun the frozen head. macOS JSC execution alone does not prove iOS App, signing, background survival or TestFlight.

## Known blockers and limits

Android's `ProcessBuilder` launches `libgugu_node.so`; the runtime uses Node filesystem/path/crypto/async-hooks/http and the coding-agent's resource/session loaders. JSC does not provide those APIs. Loading the Android bundle unchanged is not supported. The portable Pi agent loop accepts a stream function; it can be bundled separately while native code owns persistence, transport and authorization. This path still needs actual bundling and execution evidence.

The foreground host cannot promise continuous execution after iOS suspends or terminates the process. Recovery must expose interruption and uncertain writes. APNs is a wake/notification path rather than proof of continuous execution. Missing model receipts or simulator resources are unverified dependencies, not proof that the architecture is impossible.
