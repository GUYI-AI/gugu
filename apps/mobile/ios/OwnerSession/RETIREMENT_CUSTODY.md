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
the exact prepared target before invoking Keychain persistence. A later explicit
storage intent may change the target while keeping original cleanup custody;
that invalidates a prior target's permit. Write failure retains the barrier.
Only a successful exact readback removes it. A process crash after cleanup and
the exact commit can recover that completed write without a new remote mutation.
Unknown cleanup, lost original credentials, corruption, or another same-owner
token cannot take this recovery path.

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
