# Original owner credential-write custody

Refs #1877. `GuguIOSOwnerRetirementStore` persists the native credential-write
barrier at the App's private `retirement/owner-retirement.json`. It does not open
a model host, initialize a task journal, refresh a token, or replay a request.

The record contains one stable retirement UUID, the original owner/device/install
binding and JWT session ID, SHA-256 digests of the original and intended access
tokens, and capture/cleanup phases. It contains no access or refresh token.
Updates reload under an advisory sidecar lock and synchronize atomic replacements
to disk. Missing, malformed or unreadable custody is never treated as a successful
cleanup. An unreadable Keychain envelope leaves an uncaptured intent and stops
local execution before the write is rejected.

Publication, ordinary credentials, and late verification callbacks check the
persisted barrier. A fresh process cannot republish the old saved login while a
write remains pending. An explicit retry recovers the original transaction UUID,
compares its original binding/session/token digest to current Keychain data and
the native installation, then verifies that original access via the existing
`verifyUser` dependency. This does not publish an active owner. A native cleanup
capability is valid for at most five minutes and no longer than token expiry;
each use checks the exact transaction, token, installation and generation.

Successful external cleanup and local stop persist the cleanup phase before a
write permit is returned. The permit compares the original transaction UUID and
the exact prepared target under the same sidecar lock held across synchronous
Keychain persistence, exact readback and transaction removal. A later explicit
storage intent may change the target while keeping original cleanup custody;
that invalidates a prior target's permit. Write failure retains the barrier.
Only a successful exact readback removes it. A process crash after cleanup and
the exact commit can recover that completed write without a new remote mutation.
Unknown cleanup, lost original credentials, corruption, or another same-owner
token cannot take this recovery path.

Explicit iOS sign-out prepares credential-write cleanup before the SDK revokes
its Auth session. Preparation checks the expected current owner and leaves the
saved SDK envelope unchanged. The later empty-envelope write can reuse completed
cleanup only when its captured original owner, installation, Auth session and
access digest still match. This also survives a restart between revocation and
local persistence. Pending or failed cleanup still requires online verification;
a different original token or installation cannot consume the completed proof.
The ordinary commit target, generation and exact readback checks still apply.

An explicit `cancelSignOut` may abandon completed sign-out preparation while the
saved login remains unchanged. Under the same custody lock used by auth commits,
it compares the captured owner, installation, Auth session, access digest and
preparation transaction ID to the current custody and main credential scope.
Only a completed, captured, non-publication intent with an empty write target
can be removed. Another owner/token/install,
a retargeted write or unfinished cleanup is stale and leaves custody intact.
The main credential scope is read again inside the transaction before removal.

Cancellation invalidates outstanding write permits and leaves native credentials
unpublished. It neither restarts an Agent nor authenticates remotely; a later
publication must explicitly verify the saved login again. Repeating cancellation
when the matching login has no remaining intent is an idempotent no-op, including
reconciling a cancellation completed by another process. A cold process can cancel
the durable preparation using the same checks. Normal completed logout cleanup
remains reusable until an explicit cancellation or exact auth commit consumes it.

The bridge accepts the closure owner and local operation ID. At native receipt
capture, the protected record stores the matching completed preparation's durable
transaction ID and captured original credential scope when one exists; receipt
removal preserves both in the tombstone. The scope contains only binding/session
metadata and an access digest, never token bytes. This also keeps a duplicate
cancellation stale after the saved same-owner login changes, even when the old
retirement intent has already been removed.
Capture without preparation remains allowed for the current local owner, but
stores no round binding. Duplicate put cannot upgrade that record later.
Cancellation reads that native binding rather than trusting a transaction ID
from JavaScript. An
older scope, including a removed tombstone, cannot cancel a later same-owner round,
even across process restarts. Existing records without this binding are rejected
for cancellation rather than retroactively bound to a new round.

Closure composition must remove its own opaque receipt successfully before
requesting cancellation, and may do so only after a failed or expired result.
Deleted and pending results retain the barrier; native cancellation never
substitutes for account-closure authorization or restarts a stopped Agent.

Ordinary WebView/publication stop still does not permanently close the current
push session. The App currently assembles this persisted write barrier with the
push close and existing local lifecycle stop. The additional dedicated Host
retirement runner and its four-operation authorization are a separate integration
step; this change does not register GuguAgent/Push or claim cloud-host withdrawal.

Validation: `OwnerColdRetirementTests` uses private APFS files, an actual fresh
exec, and an injected identity verifier. It covers persisted blocking, cold
capability verification, deadline/token/install mismatch, unknown cleanup,
Keychain read/write failure, exact crash recovery and stale cross-handle permits.
Original OwnerSession and retirement policy groups remain separate regressions.
These checks do not exercise actual Keychain, HTTP, iOS SDK/App, EventKit or APNs.
