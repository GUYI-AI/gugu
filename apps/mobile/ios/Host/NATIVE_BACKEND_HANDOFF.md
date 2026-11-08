# Native backend and GuguAgent handoff

Refs #1877. This head includes the earlier `d6c2537` create-command and short-lease
slice. Apply all commits after the already integrated `7ad699b` in order. Register
all `Host/*.swift` sources in the App target; `GuguAgentPlugin.swift` is iOS-only.
It does not import or start Android `PhoneDeviceRoot` / `GuguPhoneActions`.

## Current availability

The concrete service constructs the real packaged Pi 1.4 / JSC loop, native
durable scheduler, existing cloud provision saga/CAS, native model short leases,
private Realtime protocol, device heartbeat, timeline and local notification
settings. Construction sends no request. HTTP and WebSocket transports use the
packaged public backend configuration and native access-only credential provider.

Agent inbox/outbox and private attachment delivery are still unconnected. The
backend explicitly reports `delivery_not_connected`, `ready: false`,
`taskTimeline: false`; device registration publishes no runtime capability.
Private subscription/heartbeat success cannot turn this into ready. Unsupported
device commands and attachment methods fail explicitly. Keep the product flag
off. No actual cloud/model/EventKit/iOS App result is claimed by author tests.

The following message-core slice adds `GuguIOSMessageBridge` and named existing
chat operations. It is not yet installed into the Pi bridge or an inbox pump.
Its agent-as reads, current group-rule ledger, source-membership checks and
stable-ID outbox are separately exercised on APFS. Reopening the store sends
nothing; an explicit retry after a lost ACK reuses the same message ID. Complete
context lineage, inbox envelope admission, attachments and full integration
remain required before removing the delivery blocker.

## App construction

Use the one App-owned `GuguIOSHostLifecycle` also passed to OwnerAccess/calendar.
Use a private APFS/no-backup root on device; do not use a shared test account root.

```swift
let service = try GuguIOSHostService(
    root: hostRoot,
    runtime: try GuguPackagedRuntime.load(),
    lifecycle: appRuntime.lifecycle,
    ownerAccess: appRuntime.ownerAccess,
    configuration: appRuntime.backendConfiguration,
    credentials: { expected in
        try appRuntime.ownerSession.credentials(expectedBinding: expected)
    },
    executor: { expected in appRuntime.calendarExecutor(binding: expected) },
    deviceMetadata: {
        ["label": UIDevice.current.name,
         "hostname": UIDevice.current.name,
         "osName": UIDevice.current.systemName + " " + UIDevice.current.systemVersion,
         "tier": "mobile",
         "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""]
    })
bridge.registerPluginInstance(GuguAgentPlugin(service: service))
```

The App owns `hostRoot` and the actual executor factory. The property/factory
names in the sample describe A's assembly inputs, not new required AppRuntime
API. The service constructor and calls below are the exact frozen Swift API.
The executor must bind its category closure to `calendarEnabled(expectedBinding:)`,
with C's actual EventKit implementation. No token is passed through this sample
except inside the native credential closure's return value.

Before sealing/retiring an owner's credential publication, await
`service.prepareOwnerRetirement(ownerId:completion:)`. Reject an error envelope;
it includes unknown model checkpoint/revoke or device-withdrawal results. Then
run the existing sessionCoordinator ordered main-write barrier and native
OwnerSession retirement. A late completion never selects the next binding.
Stopping after publication has already been sealed still cancels native work,
but network cleanup correctly fails and retains known lease IDs for recovery.

## Exact JS surface

Register plugin name `GuguAgent`. iOS must use this shape independently of the
Android `PhoneAgentHostConfig`. Unknown top-level fields reject before their
values are read; in particular URL, access/refresh token, grants and origin are
not configuration fields.

```ts
await GuguAgent.configure({
  expectedBinding: { ownerId, deviceId, installationId },
  device: { label: 'My iPhone' }, // optional, display only
})
await GuguAgent.hostState({ ownerId })
await GuguAgent.hostCall({ ownerId, id: originalUUID, channel, args })
await GuguAgent.stopHost({ ownerId })
await GuguAgent.authSession({ action: 'get' }) // refresh / sign_out also delegate
```

`configure`, `hostState`, `stopHost`, `authSession` reject their promise on an
adapter error. A valid unavailable host state resolves with its real errorCode
and ready=false. `hostCall` resolves the shared `{result}` or `{error:{code,
message,admission}}` envelope. Never generate a replacement mutation ID after a
timeout. The native origin is localOwnerUI; private Realtime callers use a
separate captured-binding remoteAgent route and cannot settle permissions or
read/write local notification preferences. `hostState` listener events contain
only the actual safe bound state, with the same name as the state method.

Auth always delegates `{available:false,session:null}` to the existing human
coordinator. Native code has no refresh authority. `sign_out` first waits for
actual native stop; failure rejects rather than triggering logout fallback.

## Local task notification settings

These named hostCall channels are wired and have the existing shared argument
shape, scoped to the currently verified native owner/device/installation:

```ts
hostCall('appSettings.get', ['notifications'])
hostCall('appSettings.getWithMeta', ['notifications'])
hostCall('appSettings.update', ['notifications', { enabled: false, sound: true }])
```

All require the local surface; update also requires the foreground owner UI.
They work after native configure even while the task host is unavailable.
An absent native preference returns `settings_unavailable`; there is no
`?? true`, remote-machine read or implicit first-read enablement. Update requires
both actual booleans and durable readback. getWithMeta's defaults match the
shared settings registry, but do not initialize an absent preference. OS APNs
authorization and chat notification preference are separate signals. The push
mirror must keep task notification state unknown until this native get succeeds.

## A-only real broker execution sequence

`GuguIOSHostProbe` is a native integration driver and is absent from plugin JS.
It cannot change readiness/capability. This lets A test the frozen real broker
path while the incomplete delivery adapter remains unavailable in the product.

1. Construct the service above with A's actual published access-only provider.
   Call `service.configure(["expectedBinding": boundDictionary])`; retain the
   returned unavailable state as evidence. Never pass private credentials in JS.
2. Construct `try GuguIOSHostProbe(service: service, expectedBinding: binding)`.
   `deepSeekV4Pro(completion:)` reads the real catalog and requires exactly one
   enabled, protocol-compatible display name `DeepSeek V4 Pro`. It returns that
   catalog ID; it does not perform inference or silently choose another model.
3. Call `probe.create(requestId: originalUUID, prompt: approvedPrompt, completion:)`.
   It repeats that exact catalog selection, passes `platform:<catalogID>` into
   the existing provision saga, executes the original create-command CAS, and
   durably admits its original initial-task ID. Creation acknowledges durable
   admission, not model completion. Keep the returned conversationId/agentUserId
   and the original UUID on retry; do not create another Agent after a timeout.
4. The real scheduler starts Pi in-process. Its first native model request issues
   a short model lease scoped to the actual agent/session/catalog ID, persists
   lease-ID cleanup custody, and uses only the issued wire model/relay/token in
   native URLSession. Native grant material never enters Pi/JSC or a journal.
5. Read `probe.snapshot(requestId: readUUID, sessionId: conversationId, completion:)`.
   A calendar write pauses with an exact SHA256 itemId. Only after the actual
   owner UI decision call `probe.respond(requestId: originalDecisionUUID,
   sessionId: conversationId, itemId: exactItemID, optionId: "approve"/"cancel",
   completion:)`. Native owner/category/OS checks remain in force. The permission
   request is one-use; its persisted resolution projects into the shared timeline.
6. Read snapshots for actual model/tool completion. A known HTTP error remains a
   structured failure; an uncertain issue is never automatically reissued. Stop
   through prepareOwnerRetirement while A's original publication is still live;
   record actual checkpoint/revoke and the research budget settlement separately.

## Resource delta and verification

Rebuild `scripts/build/build-ios-agent.mjs` from this head, then copy the complete
HostRuntime folder (agent.js, manifest and licenses). The approval-settlement
timeline change requires SHA256
`c7d44369233fdcb10ef5509866edbd47a8e77d1fc7898ee96f68ec1aa398585b`,
669413 bytes, Pi 1.4.0. Do not keep the earlier 305f asset.

The Realtime implementation follows the official
[Supabase protocol](https://supabase.com/docs/guides/realtime/protocol), version
1.0.0 JSON frames with private joins, native token updates, matching ACKs and
heartbeats. Reconnection restores subscriptions; it does not replay mutations.

Author evidence uses real macOS JSC/Pi and APFS, synthetic HTTP/model/socket/
calendar adapters, external build outputs and isolated APFS test data. It proves
neither iOS SDK/App assembly nor live broker/model/EventKit/APNs. D must rerun
the full integrated fixed head; retain the earlier 9f counterexample unchanged.
