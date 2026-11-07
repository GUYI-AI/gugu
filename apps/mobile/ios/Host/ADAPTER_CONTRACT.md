# iOS GuguAgent adapter boundary v1

Refs #1877. This adapter does not declare the phone host available by itself. The existing shared session coordinator remains the sole human-authentication authority. The native Pi host does not receive, persist, refresh or return a human refresh token.

## Native plugin surface

The integrator registers `GuguAgent` only when the actual App path is ready. Registering it affects authentication immediately: `phoneHostAuth.ts` checks plugin presence, not the local-host capability flag. Consequently `authSession` is required along with `configure`, `hostState`, `hostCall` and `stopHost`.

- `authSession({action: get|refresh|sign_out})` delegates auth ownership by returning `{available:false, session:null}`. `phoneHostAuth.ts` then executes its existing sessionCoordinator/SDK operation inside the existing ordered gate. The native method never reads a `refreshToken` parameter. On sign_out it first stops native task execution, without claiming logout or clearing shared Keychain state, then returns the delegation result. Unknown actions reject.
- `configure` receives a native typed configuration with ownerId/deviceId/installationId, category grants and public device metadata. The plugin must construct that type field-by-field and discard the legacy renderer refreshToken input; do not retain the whole CAPPluginCall/config dictionary. Native current identity and installation must match the shared-login publication. Cloud/model credentials come from a separately injected broker, not from this configuration or journal.
- `hostState({ownerId})` returns the actual backend state. Authentication missing, native runtime/storage unavailable, cloud registration missing or a retired host cannot report ready. This adapter's existence is insufficient evidence for ready or taskTimeline support.
- `hostCall({ownerId,id,channel,args})` preserves the supplied UUID. It checks current owner/installation, an explicit allowlist and a native origin. The source is constructed by native UI/RPC glue, never read from args. A local permission settlement requires the owner's real local task UI. A remote device/agent cannot supply an owner decision.
- `stopHost` retires native execution and volatile broker bindings. It never rotates or deletes the shared auth session; sessionCoordinator owns that path. `clearCredentials` cannot be interpreted as permission to erase unrelated Keychain entries.

A provides the shared-login side and native registration. B owns Host implementation. The broker must use the coordinator's published access-token-only data clients or an equivalent native short-access-token transport with no refresh authority. Private cloud operations require the real assigned identity. Model inference additionally requires the real model-budget authorization; neither runs in the offline adapter tests.

`GuguIOSHostAdapter` implements the native facade and `GuguHostCallStore` retains the original mutating request UUID on disk. It requires a concrete `GuguIOSHostBackend`, native current identity, private storage root and native owner-UI guard; no default backend exists. The backend must stop/retire its own pending configuration before acknowledging stop and must never let a late configure callback revive a retired host. Concrete cloud/provisioning/timeline wiring is still absent; this facade alone must not register the plugin or set taskTimeline/ready.

The `authSession` Swift completion is `Result<[String:Any],Error>`: successful get/refresh delegation returns available=false; sign-out first awaits actual backend stop. A must reject the Capacitor promise on `.failure`, including repeated stop failure. A JSON error object resolved as successful auth would accidentally trigger the shared logout fallback. For configure/hostState/stopHost, an adapter `error` envelope also rejects the plugin promise; hostCall alone returns the existing result-or-error host envelope.

Mutating calls persist custody before backend invocation. A duplicate in flight returns admission_uncertain, a restarted uncertain call goes to backend.reconcile, and a completed receipt rechecks authorizeReplay. The backend must reconcile actual per-phase cloud/native IDs rather than execute again. Terminal host receipts cannot be overwritten; late receipts remain stored under their original owner after retirement but cannot be delivered to the next owner. Startup reads are never permanently cached as not-ready. These properties have only injected-backend macOS tests until a real backend and App path exist.

## Owner and calendar category boundary

`GuguIOSOwnerAccess` requires five native inputs: private no-backup root, a throwing verified-identity publisher, the foreground local-owner UI guard, C's real full-access status reader, and the shared `GuguIOSHostLifecycle.revokeCalendarAccess(binding:)` closure. Its type is `(GuguIOSHostBinding) throws -> Void`: forward the supplied transaction binding unchanged; never reread the current identity inside the closure. There are no permissive defaults. A supplies identity from the authenticated shared session and native installation/device binding; neither configure input nor an unverified decoded JWT establishes this authority.

Owner and installation are UUIDs. Device ID uses the existing exact `phone-${installationId}-${ownerId}` convention from `phoneDeviceSettings.ts`; it is not an independent UUID. The shared native binding validator rejects mismatched owner/install device IDs.

- `ownerSnapshot() throws -> GuguIOSOwnerSnapshot` returns `binding: GuguIOSHostBinding` (ownerId/deviceId/installationId), `calendarConnected: Bool`, and `calendarRevision: String?` from the native durable category store. The OS status still comes from C's real EventKit reader. Missing selection defaults to disconnected; corrupt or mismatched state throws.
- If a connected snapshot observes that real full access has been revoked, it latches refusal in shared same-path memory, persists disconnected plus revocationPending, completes journal revocation, and only then clears the pending marker. Any IO failure retains refusal/pending state. Repair must finish revocation before answering a snapshot or allowing reconnect, even if OS access was re-granted meanwhile. A later OS Settings re-grant cannot reconnect the old choice or revive a consumed attempt. Snapshot never requests OS permission.
- The write-ahead refusal intent is also persisted in `calendar-revocation.pending.json`, independently of `calendar-connection.json`. A failed category load/write cannot leave only a volatile latch: the refusal intent and journal revocation are still attempted. Conversely a failed intent file still attempts the category pending record and journal revocation. Original errors propagate; all pending records remain until the complete repair succeeds. Fresh-process reads validate this intent before trusting restored category bytes.
- `ownerBinding() throws -> GuguIOSHostBinding` is pure identity publication: no category IO, OS status observation or revocation. External status/connect/disconnect must compare the expected owner/binding through this entry before any observing snapshot. `ownerSnapshot(expectedOwnerId:)` and `ownerSnapshot(expectedBinding:)` enforce that ordering themselves. Capture the host's binding for `calendarEnabled(expectedBinding:)`; an old tool must not observe or clean up the next account. Unscoped snapshot is for trusted current-owner native use only. Finish/disconnect readbacks retain their original expected binding.
- `calendarEnabled() throws -> Bool` is C executor's current native category closure. It does not replace EventKit permission checks.
- `requireLocalOwnerUI() throws` is C permission entry's identity/foreground guard. Tools never receive this entry point.
- `beginCalendarConnection(expectedBinding:) throws -> GuguIOSCalendarConnection` latches/persists refusal and pending revocation before invalidating old calendar contexts; it returns a disconnected selection/unique attempt only after revocation has completed. The attempt contains `binding` and `attemptId` and stays entirely native.
- Run C's actual EventKit connect, then `finishCalendarConnection(attempt:) throws -> GuguIOSOwnerSnapshot`. Only the same current binding, latest unconsumed attempt and actual full access can persist a connected choice. Failed/denied/late requests remain disconnected.
- `disconnectCalendar(expectedBinding:) throws -> GuguIOSOwnerSnapshot` invalidates contexts, persists disconnected and reads back the native state.

A composes begin/connect/finish inside the `GuguCalendarPermissions` native plugin; WebView receives the final snapshot, never an attempt token or partial write API. `configure(grants)` cannot set calendar truth. Owner tests inject identity/UI/OS status and do not verify real login, EventKit or the iOS App. The cloud backend protocol is an interface inventory; concrete backend wiring remains separate work.

## sessionTimeline channels and custody

| Channel | Native custody / cloud dependencies |
| --- | --- |
| sessionsList / sessionOfAgent | Native verified agent/session registry; verify owner/device against identity.active_users. No transcript bodies in cloud. |
| sessionCreateOptions | Native project + actually implemented harness surface. Report unavailable until the end-to-end host exists. |
| sessionCreateModels / sessionOptions | Broker model-access catalog. No model inference. Use actual platform model IDs. |
| sessionCreate | Persist the exact request/body before provisioning; keep operationId, provisionId, member_key and eventual agent/session IDs across retries. Continue the same provisioning saga after a lost reply. |
| sessionSend | Persist input before accepted receipt. Keep clientRequestId, original host-call ID, text and attachment references. Use the Android stable-ID namespace; do not assign a fresh delivery identity on retry. |
| sessionSnapshot / sessionAfter / sessionOlder | Native authoritative Pi/journal projection with original cursors/entry keys and current permission checks. Do not substitute a mock transcript or cloud message history. |
| sessionRespond | Native owner-only exact approval and one-use claim. Preserve the settlement/request ID; remote origins are rejected. |
| sessionQueue / sessionCancel | Native durable queue/current-turn cancellation. A timed-out host call is not proof that an admitted operation did not run. |
| sessionSetOption / sessionReloadModel | Native persisted selection after actual catalog validation; retain the same request identity. Reject a busy task as existing Android does. |
| prefetchFiles / sessionToolImage | Registered private attachment references and permission checks. No arbitrary filesystem, URL or unregistered data. |
| sessions.markSessionSeen | Native persisted seen state after identity verification. |

Unsupported methods return explicit unknown_method/unsupported. Startup reads may retry host_not_ready with the original request ID; that transient response must not be cached as a permanent result. Mutation retries reconcile durable native/cloud custody and cannot blindly execute twice.

## Minimal cloud broker inventory (existing operations, no new schema)

The cloud broker exposes named operations, not arbitrary RPC/table/URL access from JSC. Each invocation carries native owner/installation/device binding, original host request ID and phase-specific IDs. Authorization and network failures remain failures.

- Device registration/liveness: identity.gugu_devices owner-scoped upsert/read/update; identity.runtime_instance_heartbeat. Register actual runtime availability only after it is established.
- Agent validation: identity.active_users read with id/type/owner_user_id/device_id/desired_status. A record with another owner/device or non-agent type is rejected.
- Provision saga: identity.start_agent_provision_operation, claim_provision_slots, prepare_agent_provision, settle_agent_provision_terminal, complete_agent_provision; owner-scoped reads of identity.agent_provisions and gugu_device_commands. Optional birth-group validation reads chat.chats, then chat.add_group_agent with the actual initiating identity. Never bypass provisioning by minting a row or inventing an agent ID.
- Device command custody: identity.fetch_fair_pending_device_commands, recover_orphaned_device_commands, recheck_device_command_execution, and the existing CAS claim/settle updates in deviceCommands.ts. Preserve claim_token/runtime instance/command ID, and settle only after native durable admission.
- Runtime state: identity.set_agent_runtime_state; identity.report_agent_model_selection. State must come from the actual local execution path.
- Inbound messages: identity.pull_agent_inbox_v2 and mark_read_on_deliver. Advance read receipts only after input is durably admitted. Preserve source message ID and routing/privacy context.
- Model access: functions/v1/model-access actions catalog, issue, renew, checkpoint and revoke, scoped to actual agent/session/model. Only the native short model lease reaches URLSession; no human refresh token enters the Pi context.
- Attachments/outbox: existing private session-attachment helpers and messaging delivery contracts remain authoritative. These require their own named broker operations before exposure; the adapter cannot replace them with generic HTTP or a successful placeholder.

Relevant source: lib/supabase.ts, lib/sessionCoordinator.ts, lib/phoneHostAuth.ts; mobile/local-agent/nativeAgent.ts and phoneHostRpc.ts; runtime/phone-agent-task-api.mjs, phone-agent-provision.mjs, phone-agent-cloud.mjs and phone-agent-host.mjs. This list is a wiring inventory, not evidence that these channels or cloud flows have executed on iOS.
## Shared journal and runtime custody

`GuguIOSHostLifecycle(root:verifiedIdentity:)` is owned by App assembly and passed
by reference to both the native calendar connection and task backend. Separate
facades with the same canonical root share the same process-lifetime custody;
they do not reinitialize a live journal. Direct `GuguHostJournal` construction is
for cold recovery/tests, not status polling or a second App service.

- `journal(binding:) throws -> GuguHostJournal` verifies the current native
  publication and returns the one journal for this owner/install. Creating it
  reconciles interrupted disk work once per process, without creating JSC/model
  transport. It must also be the journal used by the backend's task admission.
- `host(binding:nativeKey:create:) throws -> GuguInProcessHost` caches by native
  registry UUID. Its factory receives that journal and must construct, rather
  than start, the real host. It has no cloud/model success fallback.
- `revokeCalendarAccess(binding:) throws` is the OwnerAccess closure: capture the
  expected native binding supplied by OwnerAccess (not a fresh current-owner lookup), durably invalidate disk epochs even with no runtime,
  then notify all registered runtimes with the same affected-context list. Never
  implement it with `host?.revokeCalendarAccess()`.
- `stop(ownerId:) throws` retires every registered runtime and disk admission for
  that owner, including claimed writes (which remain unknown until a real known
  receipt arrives). It attempts all hosts despite individual I/O failures and
  returns the original error. Runtime cancellation also occurs on disk failure.
- `stopAll() throws` is suitable for OwnerSession's no-argument `stopNative`
  barrier. Publication has already been sealed; this hook does not reread a
  retired binding or require credentials. App must reject on any thrown error.
- `activate(binding:) throws` is an explicit backend configure step after a
  successful retirement. Failed retirement remains blocked until a real stop
  retry succeeds. It reuses the journal and creates no automatic task resumption;
  old host instances remain stopped and cannot be reused for new turns.

All these methods are native-only. They do not register GuguAgent, provision an
Agent identity, issue a model lease, or make the concrete cloud/task backend ready.
App adds `Host/GuguIOSHostLifecycle.swift` to its production compilation (ten Host
Swift files total). There is no additional JS or resource change in this slice.

An explicit continuation inherits the source task's calendar protection in the
same durable admission transaction as its copied transcript. Its first Pi event,
model request and later history read therefore recheck access even when the next
turn does not call a calendar tool. This marker comes only from the native source
job, never from renderer/model arguments. A new OS grant cannot revive a context
that was invalidated after the transcript was copied.

## Native cloud broker and durable provision entry

`GuguIOSCloudBroker(configuration:credentials:)` takes the packaged
`GuguIOSBackendConfiguration` and a closure forwarding exactly
`ownerSession.credentials(expectedBinding:)`. URLSession uses an ephemeral
configuration without cookies/cache or redirects. Every request validates the
native binding and credentials again before returning data. It does not refresh
human credentials, log response bodies, retry HTTP mutations, or accept a bridge
URL, schema or RPC name.

`GuguIOSCloudOperation` maps only the existing Android operations listed above,
including the same provision RPCs, command CAS predicates, inbox cursor fields,
and `send_message_idempotent`. Model-access has typed catalog/issue/renew/settle
helpers. An issued lease ID is handed to the required `recordLease` callback
before parsing its token/endpoint; a malformed known grant is revoked. Callers
must persist an issuing/uncertain phase before issue and must not issue again
after a lost response. Only native memory receives `GuguIOSModelGrant`; durable
cleanup records hold the original lease ID without its token. Checkpoint failure
still attempts revoke and propagates the original error.

`GuguIOSBackendStore(root:binding:)` keeps requests, native Agent/session registry,
inputs, lease cleanup IDs and outbox records under the native binding. All
handles reload disk under the stable journal lock. An uncertain record remains
uncertain on reopen; initialization never runs work. Credential field names are
rejected before persistence. `GuguIOSStableID.strings` implements Android's
existing string-part stable-ID namespace for project/input/initial-task IDs.

`GuguIOSProvisioner` drives durable start/read/claim/prepare/create-command/
settle/complete phases. It retains operationId/provisionId/member_key, resolves
models against the real catalog, validates birth-group access, and admits the
initial task using the original Android stable ID before acknowledging creation.
Its required `executeCreate` and `admit` closures are native backend dependencies,
not success defaults. The command executor must claim/recheck/settle the actual
cloud command and persist a real local session; admission must persist the actual
input before returning. No new cloud identity or schema is introduced.

These four sources plus `OwnerSession/GuguIOSOwnerSession.swift` and
`OwnerSession/GuguIOSBackendConfiguration.swift` compile with the existing Host
sources on macOS. `HostBrokerTests` exercises synthetic HTTP plus real APFS;
`HostProvisionTests` uses a synthetic command executor, not a real cloud-created
Agent or Pi job. Concrete GuguAgent registration, command/event subscription,
local task scheduling, attachment/inbox/outbox delivery and model renewal
lifecycle still require their backend integration. This entry alone never sets
`ready`, `taskTimeline`, or a runtime capability.
