# Visible APNs client

Visible notification permission, native registration custody, and scoped reconciliation hints. No background mode, service extension, HTTP implementation, arbitrary navigation, Agent execution or token storage. Server wire mapping is pinned to `GUYI-AI/gugu-supabase@3b473356f3b99ab8de6b19c5dec16de586498227` (`services/push/README.md`). The original-session close RPC is pinned to `GUYI-AI/gugu-supabase@f0e6ead08f5443efbd579f6f48c2915b45f522cd` (`services/push/README.md:35`). Database behavior and CI must be verified separately before deployment.

## Integration owned by the App integrator

Compile four sources under `Sources/GuguPushNotifications/` plus `GuguPushNotificationsPlugin.swift`. Package.swift builds the policy/platform sources and focused tests; the Capacitor plugin is outside the package target. No resources or third-party dependencies.

Create one main-actor `GuguUNPushPlatform`, `GuguPushClient` and strongly retained `GuguPushNotificationDelegate`. Inject the real verified owner/install binding, foreground owner guard, actual notification preferences, existing on-screen/one-OS-outlet foreground policy, and native reconciliation handler. Missing provider remains unavailable. The notification delegate does not install itself or replace Capacitor's delegate; establish App-lifetime forwarding before launch completes. Forward AppDelegate APNs success/failure to the platform on the main actor, without logging token/error objects. An unsolicited callback withdraws authority through an injected `client.invalidate()` callback.

`GuguPushNotifications` exposes status/requestAuthorization/register/revoke with `{expectedBinding:{ownerId,deviceId,installationId}}`. Status never prompts/registers. Only a foreground owner request can ask for alert/sound/badge, and only while notDetermined. Provisional permission does not count as visible-alert permission. OS settings and confirmed server registration are returned separately; token receipt is not a server ack. Device IDs use the existing phone-install-owner format.

`GuguPushRPCProvider(transport:environment:)` maps the frozen identity RPCs. When the signed APNs environment is not yet available, `GuguPushRPCProvider(retirementTransport:)` allows only closeInstallation; register and ordinary revoke reject before I/O. Use that instance only in the native cleanupEvidence closure. Keep the ordinary client provider nil until its signed environment is known, so discovery does not imply registration availability. The transport uses the existing native authenticated backend client and must recheck a purpose-bound credential capability at each I/O boundary. No access/refresh token or environment is accepted from JavaScript. Environment must come from the actual signed build, with no sandbox/production fallback; topic is app.gugu.chat. Chat/task enablement and chat/task sound are four required independent booleans. Register sends p_chat_sound_enabled and p_task_sound_enabled, never the old combined sound field; foreground presentation selects the acknowledged sound for the payload kind. No local task preference read means unavailable, not a default true or another machine's value. All native token bytes become lowercase hex; maximum 2048 bytes / 4096 hex characters. The server-returned UUID generation is separate from the native asynchronous epoch. Notification decoder is `GuguPushPayload.decode`, projecting only versioned identifiers, kind and a bounded decimal revision; optional routing/body fields are not forwarded.

## Explicit credential retirement barrier

`retire(expectedBinding:retirementBinding:cleanupEvidence:) async throws -> GuguPushRetirementReport` is native only and needs no foreground UI. `retirementBinding` must validate the integrator's restricted retirement capability and return `GuguPushRetirementScope(binding:originalSessionId:)`. Derive the original session ID only from that capability's verified original access JWT. The client captures and compares the entire scope at every asynchronous boundary; an owner/install match alone cannot authorize another session. Ordinary status/register/requestAuthorization/revoke never use this validator as a fallback.

Retirement immediately withdraws local notification authority, unregisters APNs and requests removal of this App's delivered notifications. It then settles an in-flight register, retaining exact known server receipts before rejecting stale/cancelled callers. The native cleanup closure receives the captured scope and may call `GuguPushRPCProvider.closeInstallation(scope:)` through a transport authorized with the same restricted old capability. This maps `identity.mobile_push_close_installation(p_installation_id,p_device_id,p_original_session_id)` and requires numeric v=1, actual boolean closed=true, matching owner/session/install/device and one of:

- `installation_fenced` with a canonical UUID fence_id: the old scope is persistently closed and its registrations removed.
- `session_absent` with an explicit null fence_id: the original Auth session was physically absent.

Neither proof means “never registered.” Missing/false/malformed/mismatched evidence, a changed original session or an expired capability fails the barrier. Scope close covers unknown register results and prevents that old scope from registering later. Re-enabling push for a closed scope requires a new real Auth session; there is no implicit unfence. The backend must prove its transaction/lock behavior independently.

Without a close proof, known registration/server-generation pairs can still be precisely revoked. A false/non-boolean/unknown revoke is not success; true receipts survive cancellation checks. That yields disposition `exactRegistrationsRevoked`, **serverCleanupVerified=false**, which may complete ordinary UI revoke but must not release a credential-write barrier. Empty first/cold process memory yields `serverCleanupUnverified` and local phase `retiredUnverified`; it never implies server absence. The integrator can obtain a close proof even with no memory-only receipt or token, so first/cold sign-out does not require a fabricated “never registered” flag. Only a report with `serverCleanupVerified=true` plus the matching scope-bound cleanupEvidence may release the native credential-write barrier.

`resolveUncertainRegistration(expectedBinding:retirementBinding:)` is an optional explicit native recovery entry when a prior idempotent registration request remains in memory. It retries exactly that request, saves cleanup metadata and never publishes registration authority. It rechecks the same restricted original session after the response. It is not automatic and does not replace the durable close needed for credential retirement. Unknown request/token bookkeeping is memory-only; cold cleanup uses the original-session close instead of guessing from an empty map.

A owns the retirement credential lease and publication/write-latch sequence. Calling the normal OwnerSession credentials getter after sealing general publication is not a solution. This module does not read Keychain or create another authentication/refresh path. A failed/unverified barrier must propagate to the credential-write caller. Keep the plugin/registration lifecycle disabled until this composition is actually validated.

APNs token requests cannot overlap. The OS callback has no request ID; a pending continuation remains tied to the original operation across invalidation/unregister, and must drain before another owner's request. If APNs does not call back while offline, the state remains pending rather than attributing a future callback to a new owner.

## Notification behavior and limits

Foreground receipt/default tap must match the actual owner/install, acknowledged server registration/generation, current preferences and permission. Duplicate receipt/tap hints are separately bounded in memory. Accepted input only prompts authenticated canonical reconciliation. It never executes a tool or follows payload URLs. Foreground alerts additionally require the App's shared on-screen/one-outlet policy; sound follows current acknowledged preferences. Other actions/dismissals are ignored, and all UN completion paths complete.

The App must reconcile independently when foreground/cold owner readiness completes. Cold payloads without a current ack are rejected; an APNs outage must not block ordinary recovery. Already delivered background/lock-screen banners cannot be intercepted by these application callbacks. The provider must revoke old bindings and send generic text; even server revoke cannot recall an already admitted APNs request. No continuous phone-Agent execution or guaranteed OS presentation is implied.

macOS tests inject identity/OS/provider/transport. They do not prove iOS SDK compilation, UN permission UI, APNs issuance, real RPC/Keychain/HTTP, lock-screen delivery or TestFlight. iOS-only source needs actual SDK validation by the integrator.

Apple references: [permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [callbacks](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions).

## App wiring

The App now registers this plugin against the **same** client retained by the
native credential retirement barrier. Only the Runtime plugin registration list
changes. AppDelegate forwards APNs success/failure without logging token bytes.
Ordinary HTTP uses native OwnerSession credentials and validates admitted receipts;
logout/account replacement still closes the original session installation through
the restricted retirement capability. Unknown outcomes remain unverified.

The renderer mirrors chat enable/sound and this installation's saved task
notifications enable/sound independently. Missing task settings suspends local
registration authority. It never starts a phone Agent merely to register push.
Permission is requested only through the existing notification settings action.
Foreground/owner readiness always wakes canonical revision reconciliation even
without APNs. Received pushes only wake that path; default taps additionally check
canonical chat visibility before using the normal notification route. Remote
foreground banners are suppressed in favor of the existing local message outlet.
Token changes, preferences and foreground readiness request a fresh acknowledgement;
stale asynchronous callbacks cannot publish the old owner or generation.

`APS_ENVIRONMENT` is `development` for Debug and **production** for Release in the
Xcode target. Both `App.entitlements` and `Info.plist:GuguAPNsEnvironment` expand
that same build setting. Native code maps development to sandbox and production to
production, rejects missing/unknown values, and never uses the business DB name.
TestFlight must archive Release with production. The signing/export pipeline must
compare the **exported IPA's signed aps-environment** with the expanded Info.plist
value and require production; source settings alone are not evidence of a correctly
signed archive. This change does not manage signing identities or profiles.

Verification boundaries: RPC mocks and simulator-visible injected alerts are
separate from actual APNs delivery. Staging register/revoke round trips remain
UNVERIFIED until the matching server migration is deployed. Physical-device
remote delivery, lock-screen display and TestFlight remain UNVERIFIED.
