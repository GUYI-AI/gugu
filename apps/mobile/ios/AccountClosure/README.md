# Local account closure (iOS)

Refs #2816, #2777, #2720. This implements only the native local eraser, opaque
receipt storage and shared platform boundary. It never calls account-closure or
authentication endpoints. The shared controller owns pre-confirm cleanup, result
classification, operation-ID recovery and retry/terminal UI.

## Authority and receipt lifetime

`put({ownerId, localOperationId}, receipt)` captures authority from the current
local main Keychain envelope's owner under OwnerSession's auth-commit lock. It
does not require a live server session. New scopes for another owner are refused.
The local operation ID is an opaque stable string (1–256 UTF-8 bytes), not a
required UUID or a backend request ID. An identical repeated put is idempotent; changing the receipt conflicts.
`get`, `remove` and `eraseLocal` require the matching captured native scope;
passing an owner ID without that put cannot read or erase it.

The receipt is opaque. Possession is not interpreted as proof of a server-side
`deleted` result: the trusted shared controller calls erase only after that
confirmed result. No receipt means no new erasure. While erase is pending, the
controller retains the receipt. After complete it explicitly removes it;
failed/expired results remove it without erasing. There are no native retry timers.

After remove the Keychain deliberately retains a receipt-free captured-operation
marker: it supports repeated remove and already-completed erase, but cannot
authorize an unfinished erase without a receipt.
The proposed controller policy retries pending with the same scope every two
seconds, at most five times, then stops automatic retry; copy and later manual
retry belong to the controller.

Dedicated Keychain items use ThisDeviceOnly/WhenUnlocked, never synchronize and
have no plaintext fallback. Locked/unavailable storage is an error, not null.
Remove clears receipt bytes and retains only a hashed captured-operation tombstone
and completion checkpoint for idempotent calls. It contains no literal owner ID
or credential. A removed, incomplete operation cannot start erasing. The shared
operation handle must survive restart; it is not a backend request-ID contract.

Bridge logging must remain disabled (`capacitor.config.ts: loggingBehavior=none`):
Capacitor otherwise logs native call/reply payloads. Do not add receipt values to
application logs, error text, URLs, telemetry or screenshots. Native errors use
fixed safe messages. Neither receipts nor arbitrary storage keys are exposed as
Agent tools.

## Erasure and interrupted work

The native pre-confirm host/push retirement must already have completed.
Otherwise local erase rejects with `closure_not_prepared` as a defensive check;
it does not replace or choose the shared controller's pre-confirm ordering. This
eraser never uses a dead credential to repeat server cleanup. It invalidates only
the closed owner's local adapter/runtime, refuses an active unprepared host, and
leaves B running. A known stop in progress or mixed unfinished retirement record
can return pending. Completed A-only retirement custody is removed; mixed A/B
custody is not edited until its original transaction finishes.

Every resumed attempt revalidates in-memory fences and retirement prerequisites,
even if earlier filesystem steps have checkpoints. Only the fixed owner paths
below are removed, with canonical UUID, path and symlink checks:

- `service/backend/<owner>`: Agents, tasks, inbox/outbox, requests and preferences.
- `service/host-calls/<owner>`: bridge call receipts.
- `host/<owner>`: execution/tool journals.
- `categories/<owner>`: calendar connection/revocation state.

Directory deletion is synchronized before its protected checkpoint. If an effect
finishes but checkpointing fails, repeating that effect is safe. Authentication
main-slot removal uses the existing auth lock and only deletes the exact closed
owner; a newly logged-in B remains unchanged. Ordinary auth-write semantics and
retirement permits are unchanged.

Installation identity, other owners, system Calendar events/permissions, APNs
token/permissions and exported user files are preserved. Push registration
custody is memory-only; unknown original registration effects must complete
pre-confirm cleanup rather than lose their only receipt. Fixed unattributed names
can include `auth-main-unattributed`, `auth-code-verifier`, `auth-oauth-pending`,
`files-staging`, `retirement-unattributed`, `push-deduplication`. They contain no
values, receipts or owner IDs, are always returned as an array, and do not prevent
complete. FileSave staging and push deduplication have no owner index, so this
operation does not guess their ownership or clear their shared directories.

## Other platforms and validation

The common `AccountClosureNative` interface lives in the platform layer. Other
shells explicitly reject through unsupported placeholders; there is no fallback
to localStorage. Android can supply the same interface with its encrypted
Keystore-backed adapter; this change includes no Android native implementation.

Deterministic native tests cover A/B preservation, missing authority, pending
receipt lifetime, interrupted checkpoint/new-instance recovery, repeated calls,
missing receipts, symlinks, mixed retirement byte preservation and late A runtime
rejection. App-hosted simulator coverage exercises actual Keychain items in a
unique fixture namespace. Real App two-account closure and the live backend
rollout remain separate pre-ship acceptance, not established by these tests.
