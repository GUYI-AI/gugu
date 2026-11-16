# Private Android account closure preparation, V2

Refs #2942. This is an isolated source candidate based on the existing mobile
closure implementation. It does not enable account closure V2 or add a public
bridge, UI, HTTP call, OTP flow, final confirmation or deployment.

## Local authority and storage

`AndroidAccountClosureV2` is package-private, unregistered and hard-disabled.
`AccountClosureOperationV2` separates its testable local state machine from native
identity, protected storage and runtime-drain ports. A test-only injected flag is
not an application feature switch.

The native binding reads the committed Auth envelope under `STORAGE_LOCK` and
captures its owner and original Auth session ID. Decoding the session ID captures
an identifier; it does not verify a JWT or assert server-side session validity.
The server must still authenticate every future request. Installation and device
identity come from native locators, outside the host-store/auth lock inversion.
The device locator is read again after draining, before the final scope check.

One encrypted record per owner contains both the discoverable operation and its
32-byte native CSPRNG receipt. It uses the existing AndroidKeyStore AES-GCM,
no-backup, file-fsync/rename/directory-fsync primitive under a new key domain.
This keeps scope discovery and receipt persistence in one atomic replacement.
Its record key stays stable within the native profile when an installation
changes; the stored binding/AAD must reject the change instead of hiding the
old record and generating another secret. No ordinary metadata API exports the
receipt, access token, refresh token, or OTP.

The new format has magic `0x47554332`, storage version **3**, and explicit
protocol version **2**. Existing V1 records whose binary header is already `2`
are never reinterpreted. V1 storage keys and formats remain unchanged.

| Protected field | First-segment behavior |
| --- | --- |
| ownerId / localOperationId | Exact existing owner/opaque operation scope; no path interpretation |
| originalAuthSessionId | Captured from native Auth; a new SID cannot adopt the record |
| installationId / canonicalDeviceId | Native binding, rechecked before local completion |
| receiptSecret / nativeGeneration | Native-generated once and persisted before stopping |
| localRevision | Local CAS; a stale revision or native generation rejects |
| serverGeneration / serverOperationId / requestId | Absent until a trusted native transport exists |
| operationRevision | Absent; never substituted with localRevision |
| challengeGeneration / confirmationId | Reserved as zero/absent; no send or confirmation intent is created |
| checkpoint | Only the three local states below |

## Private operations and fences

`beginOrRestoreOperation(scope)` restores the same protected operation and secret.
A second unresolved operation for the same owner is rejected. The ordinary read
returns metadata only. A private no-argument read discovers the captured operation
for the current native owner after journal loss, without enumerating other owners
or generating another secret. Missing, corrupt, incompatible or unreadable storage never
becomes a fresh successful operation. A signed-out or changed-owner/SID restore
currently rejects; a later signed-out result-recovery authority is not invented.

Local progress is `captured -> preparing -> local_prepared`.
`checkpointOperation(scope, expectedLocalRevision, nativeGeneration, event)` only
accepts `request_local_preparation`. It cannot accept cloud terminal words or mark
local preparation complete. Only `prepare(scope)` can advance to `local_prepared`,
after both native runtime drains finish, neither owner runtime remains busy, and
the original full scope/revision/generation is rechecked.

No runtime wait holds the Auth monitor. Existing native runtime admission also
checks the persisted V2 seal, even if the capability is later disabled. The final
child launch repeats that check under the Auth monitor after asset preparation.
Native capability-grant writers check that same seal under the Auth monitor;
the V2 drain checks the durable owner-grant revocation rather than ignoring a
failed preferences commit.
V1 prepare/retire/cancel and its erasure-readiness callback refuse a pending V2
record; V2 refuses an already active V1 preparation. V1 public signatures and
receipt interfaces are unchanged. These guards do not delete registrations,
Agents, messages, files, or credentials.

The side-effect boundary carries an unforgeable native admission object minted
from the protected original owner/SID, scope, native generation and local revision.
It rechecks the record under the Auth monitor before owner-grant revocation.
A process-local Auth mutation fence prevents a different owner/SID replacement
during synchronous stop-request dispatch; same-SID refreshes remain permitted.
Runtime stop requests take their existing service locks without holding the Auth
monitor. The dispatch fence is removed in `finally` before awaiting drain exit
proofs, and the normal complete-scope check still runs after those proofs.
The V2 modern-runtime stop helper does not repeat grant revocation or attach a
late, unadmitted reservation-release callback.

V1 preparation captures its starting generation and stage. Its late completion
checks the V2 fence and requires that exact generation/stage before writing
STOPPED. Cancelling G1 to state zero and then capturing V2 cannot let the old G1
completion resurrect the V1 fence. A replaced V1 generation also rejects.

`local_prepared` is not cloud preparation or deletion proof. No trusted server
result entry is implemented here. Server binding, cancellation and erasure
therefore always reject with `trusted_result_unavailable` in the private core;
the application composition remains disabled before touching any storage.
There is no renderer boolean/string override, automatic restart, or secret
removal. Enabling this source without a trusted result/cancellation path would
leave a deliberately unreleased native seal and is outside this change.

## Validation boundary

`AccountClosureOperationV2Test` contains 22 deterministic source cases covering
default closure, atomic persistence ordering, restart, scope replacement, owner /
SID / device / installation isolation, secret-free metadata, storage failure,
CAS, renderer terminal rejection, drain completion, failed checkpoints, corrupt
formats, persistent fences and unavailable trusted-result actions.
The five additional cases cover SID2 observed between preparing and admission,
cross-owner/SID Auth replacements during dispatch, dispatch-failure fence release,
the valid V1 G1 put/remove/cancel -> V2 seal -> late V1 callback interleaving, and
cancelled/replaced V1 completion without a V2 record. They use actual core and
completion-boundary functions with injected native ports; they do not exercise
Android service locks or KeyStore.

For this initial source delivery, those Java cases have **not been compiled or
executed**. Neither Android compilation, native startup, AndroidKeyStore / fsync
fault injection, actual runtime races, nor a device session has been exercised.
The source must stay disabled pending that validation and trusted-result design.
