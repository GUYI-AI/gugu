# Visible APNs client

Visible notification permission, native registration custody, and scoped reconciliation hints. No background mode, service extension, HTTP implementation, arbitrary navigation, Agent execution or token storage. Server wire mapping is pinned to `GUYI-AI/gugu-supabase@94fb939d29e6ac004a3ac26b24eca7ceead550d4` (`services/push/README.md`).

## Integration owned by the App integrator

Compile four sources under `Sources/GuguPushNotifications/` plus `GuguPushNotificationsPlugin.swift`. Package.swift builds the policy/platform sources and focused tests; the Capacitor plugin is outside the package target. No resources or third-party dependencies.

Create one main-actor `GuguUNPushPlatform`, `GuguPushClient` and strongly retained `GuguPushNotificationDelegate`. Inject the real verified owner/install binding, foreground owner guard, actual notification preferences, existing on-screen/one-OS-outlet foreground policy, and native reconciliation handler. Missing provider remains unavailable. The notification delegate does not install itself or replace Capacitor's delegate; establish App-lifetime forwarding before launch completes. Forward AppDelegate APNs success/failure to the platform on the main actor, without logging token/error objects. An unsolicited callback withdraws authority through an injected `client.invalidate()` callback.

`GuguPushNotifications` exposes status/requestAuthorization/register/revoke with `{expectedBinding:{ownerId,deviceId,installationId}}`. Status never prompts/registers. Only a foreground owner request can ask for alert/sound/badge, and only while notDetermined. Provisional permission does not count as visible-alert permission. OS settings and confirmed server registration are returned separately; token receipt is not a server ack. Device IDs use the existing phone-install-owner format.

`GuguPushRPCProvider(transport:environment:)` maps the frozen identity RPCs. The transport uses the existing native authenticated backend client and must recheck a purpose-bound credential capability at each I/O boundary. No access/refresh token or environment is accepted from JavaScript. Environment must come from the actual signed build, with no sandbox/production fallback; topic is app.gugu.chat. All native token bytes become lowercase hex; maximum 2048 bytes / 4096 hex characters. The server-returned UUID generation is separate from the native asynchronous epoch. Notification decoder is `GuguPushPayload.decode`, projecting only versioned identifiers, kind and a bounded decimal revision; optional routing/body fields are not forwarded.

## Explicit credential retirement barrier

`retire(expectedBinding:) async throws` is a native entry, with no foreground-UI requirement; it must run before the App clears/replaces credentials. It immediately withdraws notification authority, unregisters APNs and requests removal of this App's delivered notifications. It then waits for an in-flight register and retains its exact known server receipt even if that register's original caller is stale/cancelled. It revokes each known registration/server-generation pair. A false/non-boolean/unknown revoke is not success. True revoke receipts are retained as cleanup facts before cancellation checks. A native invalidation never throws away known/pending server-side writes.

An unknown register result blocks retirement and new registrations. `resolveUncertainRegistration(expectedBinding:)` is an explicit native recovery entry: it retries the identical idempotent registration using the memory-only request, saves cleanup metadata, and does not publish registration authority. It is not called automatically. After recovery, retire again with the still-valid purpose-bound old credential. No server tombstone for unknown registrations is assumed. RPC/unknown-write bookkeeping is memory-only; loss of the process loses that knowledge. A new process must re-register with a fresh APNs token and actual current login (or obtain separately verified server-session deletion). It must not claim successful revoke from an empty in-memory state.

A owns the retirement credential lease and publication/write-latch sequence. Calling the normal OwnerSession credentials getter after its retirement latch closes is not a solution, and this module does not read Keychain or bypass that latch. Do not enable the plugin/registration lifecycle until that composition is actually validated. A failed barrier must propagate to the credential-write caller.

APNs token requests cannot overlap. The OS callback has no request ID; a pending continuation remains tied to the original operation across invalidation/unregister, and must drain before another owner's request. If APNs does not call back while offline, the state remains pending rather than attributing a future callback to a new owner.

## Notification behavior and limits

Foreground receipt/default tap must match the actual owner/install, acknowledged server registration/generation, current preferences and permission. Duplicate receipt/tap hints are separately bounded in memory. Accepted input only prompts authenticated canonical reconciliation. It never executes a tool or follows payload URLs. Foreground alerts additionally require the App's shared on-screen/one-outlet policy; sound follows current acknowledged preferences. Other actions/dismissals are ignored, and all UN completion paths complete.

The App must reconcile independently when foreground/cold owner readiness completes. Cold payloads without a current ack are rejected; an APNs outage must not block ordinary recovery. Already delivered background/lock-screen banners cannot be intercepted by these application callbacks. The provider must revoke old bindings and send generic text; even server revoke cannot recall an already admitted APNs request. No continuous phone-Agent execution or guaranteed OS presentation is implied.

macOS tests inject identity/OS/provider/transport. They do not prove iOS SDK compilation, UN permission UI, APNs issuance, real RPC/Keychain/HTTP, lock-screen delivery or TestFlight. iOS-only source needs actual SDK validation by the integrator.

Apple references: [permission](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications), [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns), [callbacks](https://developer.apple.com/documentation/usernotifications/handling-notifications-and-notification-related-actions).
