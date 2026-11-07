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

## Owner and calendar category boundary

`GuguIOSOwnerAccess` requires five native inputs: private no-backup root, a throwing verified-identity publisher, the foreground local-owner UI guard, C's real full-access status reader, and `GuguInProcessHost.revokeCalendarAccess`. There are no permissive defaults. A supplies identity from the authenticated shared session and native installation/device binding; neither configure input nor an unverified decoded JWT establishes this authority.

- `ownerSnapshot() throws -> GuguIOSOwnerSnapshot` returns `binding: GuguIOSHostBinding` (ownerId/deviceId/installationId), `calendarConnected: Bool`, and `calendarRevision: String?` from the native durable category store. The OS status still comes from C's real EventKit reader. Missing selection defaults to disconnected; corrupt or mismatched state throws.
- `calendarEnabled() throws -> Bool` is C executor's current native category closure. It does not replace EventKit permission checks.
- `requireLocalOwnerUI() throws` is C permission entry's identity/foreground guard. Tools never receive this entry point.
- `beginCalendarConnection(expectedBinding:) throws -> GuguIOSCalendarConnection` invalidates old calendar contexts before writing a disconnected selection and unique attempt. The attempt contains `binding` and `attemptId` and stays entirely native.
- Run C's actual EventKit connect, then `finishCalendarConnection(attempt:) throws -> GuguIOSOwnerSnapshot`. Only the same current binding, latest unconsumed attempt and actual full access can persist a connected choice. Failed/denied/late requests remain disconnected.
- `disconnectCalendar(expectedBinding:) throws -> GuguIOSOwnerSnapshot` invalidates contexts, persists disconnected and reads back the native state.

A composes begin/connect/finish inside the `GuguCalendarPermissions` native plugin; WebView receives the final snapshot, never an attempt token or partial write API. `configure(grants)` cannot set calendar truth. This commit's owner tests inject identity/UI/OS status and do not verify real login, EventKit or the iOS App. The cloud backend protocol is an interface inventory; the concrete backend and GuguAgent adapter are still separate work.

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
