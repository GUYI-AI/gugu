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

## Build the portable asset

`node scripts/build/build-ios-agent.mjs` creates the generated `App/App/HostRuntime` folder, including `agent.js`, its SHA-256 manifest and full dependency license bodies. With an isolated tooling install, set `GUGU_IOS_TOOLING_ROOT` to the directory whose `node_modules` contains the pinned packages. Normal builds resolve repository/mobile dependencies. The folder must be registered as an App resource by the iOS integrator; generating it does not prove it is inside an App.

The Swift sources for the first bridge slice are `GuguHostContracts.swift` and `GuguJavaScriptRuntime.swift`. The native entry point is `GuguJavaScriptRuntime(asset:expectedSHA256:request:cancel:event:)`. There is no Capacitor plugin or production capability registration in this slice. JavaScript receives no model credential, URL or general filesystem callback.

`HostTests/main.swift` runs the actual packaged Pi asset through the same Swift/JSC implementation on macOS with deterministic transport responses. Compile it with the two Swift sources and pass the generated `agent.js` path. Its printed receipt distinguishes fixture counts from real model/EventKit calls. The initial scope is text and non-streamed OpenAI-compatible responses; unsupported content/protocols fail explicitly. Streaming, complete coding-agent session resources and automatic compaction are not implemented by this proof.

## Native state slice

Compile all five files in `Host/`: contracts, JavaScript runtime, journal, native coordinator and model transport. `GuguInProcessHost` is the native entry point. Its executor is the calendar adapter; its `currentIdentity` closure must read the native account and no-backup installation identity. A native model lease can be installed only after the real account/budget authorization is available. This library does not mint identities or model credit.

The coordinator admits a job durably before starting Pi. It supports exact-turn cancellation, local native owner approval, gated task reads and explicit continuation with a new job ID after process restart. Initialization never resumes work. Missing tool results in a continuation are reconstructed from actual native receipts or explicit unknown/interrupted recovery records; the original Pi event stream is not rewritten. `HostStateTests/main.swift` tests the real journal and JSC with deterministic native/model fixtures. It is separate from a real model/EventKit/App test.

`revokeCalendarAccess()` must be called before category-off/reconnect. It permanently invalidates protected context and pending approvals, cancels active turns and preserves uncertain/known write receipts. A re-grant cannot revive that old context; a new input can start with a new context epoch. Observed permission failures also enter this path. The integrator must connect explicit grant changes; current permission booleans alone cannot detect an unobserved revoke-and-regrant. `stop()` must be called when retiring an account/host. Late known write outcomes remain in the journal but cannot be delivered across that boundary.

`finishMutation` takes the successful raw OS receipt data. The journal stores its `ok/data` envelope. `argumentsSHA256` is SHA-256 of exactly the UTF-8 bytes of `argumentsJSON`, while approval and deduplication separately bind the action and full task context.

Existing `GuguAgent` methods are not implemented by this native library: `configure`, `hostState`, `hostCall`, `stopHost`, renderer/session timeline entry points, cloud device registration, authenticated model lease acquisition/renewal/revocation and outbox delivery need their adapters. Do not advertise `phoneAgentAvailable` from this slice alone. The native URLSession transport accepts an already-authorized ephemeral lease; no real request is part of the offline tests.

The later `GuguIOSHostAdapter` facade and owner/category custody are documented in `ADAPTER_CONTRACT.md`; they still need a concrete cloud/provisioning backend. `GuguJavaScriptRuntime.readTimeline` now projects authorized native journal Pi `message_end` events with the existing shared session timeline reducer. Native admission/failure records keep a distinct `native-*` provenance; a completed task with missing Pi records fails rather than substituting summary text. Shared cursors, incremental reads, transport trimming and tool failure status are retained. This is an internal native API, not a renderer/JSC-model capability. Its caller must verify the selected owner/installation/session/context, source order and calendar permissions both before reading and after the asynchronous projection. No concrete sessionTimeline backend is implied by the projection API.

The projection bundles the repository's real session-core reducer, its existing secret-redaction function and pinned Zod. There is no Node filesystem/JSONL watcher, cloud-chat replacement or downloaded code path. The generated HostRuntime folder changes and must be recopied with its manifest/license bodies for the same source head. MacOS tests use actual Pi events from two real local loops with explicit model/tool fixtures; they are not real model, calendar or iOS App acceptance.

`GuguInProcessHost.readTimeline` is the internal protected reader for a registry-verified session context. It selects only that owner/install/agent/session/context epoch, uses persisted admission sequence, checks each task's current data access before projection and rechecks after the async result. New admissions record native time and sequence. Multiple prototype tasks without provable order fail `record_unreadable`; dictionary/UUID order is never presented as history. This does not yet implement a concrete cloud registry, session creation, input/attachment queue, approval settlement projection or outbox backend.
