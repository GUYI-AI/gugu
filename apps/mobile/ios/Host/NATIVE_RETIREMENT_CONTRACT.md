# Native retirement cleanup contract

Refs #1877. This fixes a cold-start boundary: ordinary owner credentials require
an active publication and reject after the main-write barrier is closed. Cleanup
must work from the original persisted retirement transaction even when this
process has never published an owner. The existing pre-seal
`prepareOwnerRetirement` path alone does not cover that case.

This is the native assembly contract. Implementation and targeted verification
are delivered separately with a frozen source head; this document alone is not
a passing-run claim. Retirement credentials are never passed to the ordinary
broker.

## Native signatures

```swift
enum GuguIOSRetirementOperation: Equatable {
    case checkpointLease(String)
    case revokeLease(String)
    case readOwnedDevice
    case withdrawOwnedDevice
}

// Native memory only; not Codable, not a host result, redacted debugDescription.
struct GuguIOSRetirementAuthorization {
    let binding: GuguIOSHostBinding
    let retirementId: String
    let operation: GuguIOSRetirementOperation
    let expiresAt: Date
    // Private to the dedicated retirement transport; construction is native-only.
    fileprivate let accessToken: String
}

extension GuguIOSRetirementCleanup {
    typealias Authorize = (
        _ expectedBinding: GuguIOSHostBinding,
        _ retirementId: String,
        _ operation: GuguIOSRetirementOperation
    ) throws -> GuguIOSRetirementAuthorization
}

// A owns this OwnerSession implementation and the AppRuntime mapping.
func retirementAuthorization(
    expectedBinding: GuguIOSHostBinding,
    retirementId: String,
    operation: GuguIOSRetirementOperation
) throws -> GuguIOSRetirementAuthorization

// B owns this separate native transport/runner, with no generic request method.
GuguIOSRetirementCleanup(
    root: URL,
    configuration: GuguIOSBackendConfiguration,
    authorize: @escaping GuguIOSRetirementCleanup.Authorize,
    send: GuguIOSCloudBroker.Send? = nil
)

// Native service method. Absent from GuguAgent/hostCall/JSC allowlists.
func retireOwner(
    expectedBinding: GuguIOSHostBinding,
    retirementId: String,
    completion: @escaping (Result<Void, Error>) -> Void
)
```

The authorization value will have a native initializer taking the displayed
binding/retirement/operation/expiry and an access token. Its token is private to
the cleanup transport's source file. The constructor dependencies are the same
App-owned root and packaged public backend target used by the ordinary service.
No renderer-selected URL, token, operation, lease list or cleanup root is accepted.

## A: authority after sealing, including cold start

The persistent main-write/retirement record is authoritative for the exact
original binding and retirementId. Reuse that same ID on every explicit retry;
do not mint a new transaction to bypass a failure. A cold process may recover
this authority with no active publication. It must validate its persisted
retirement proof and the matching original Keychain owner/access session using
OwnerSession's existing identity verification before making a permit available.
It must not publish an active owner, select currentBinding, or grant ordinary
credentials as a side effect. A owns the verification and any coordinator work.

Each permit is for one enum operation, the original binding and retirementId.
Its lifetime is bounded by the original access-token expiry and a short native
deadline (at most five minutes). The provider is called before and after each
request; binding, retirementId, operation, token and expiry must still match.
An expired/mismatched/replaced barrier rejects. There is no token refresh in Host
and no fallback to a new owner's credentials. If the original session is no
longer usable, cleanup remains pending for A's explicit reconciliation.

This is a **local native capability boundary** around an existing authenticated
session, not a claim that the existing JWT has new server-side cleanup-only
claims. No cloud identity, schema, endpoint or model grant is introduced.

## B: closed operation list

Only these fixed operations may use the separate authorization provider:

| Native operation | Fixed existing wire operation | Mandatory scope |
| --- | --- | --- |
| checkpointLease | POST model-access, action=checkpoint | One known leaseId from the original native lease ledger |
| revokeLease | POST model-access, action=revoke | The same registered leaseId, without any issue/renew |
| readOwnedDevice | GET identity.gugu_devices | Exact original device_id AND user_id; select only device_id,user_id,capabilities,updated_at |
| withdrawOwnedDevice | PATCH identity.gugu_devices | Exact original device_id AND user_id AND captured updated_at; clear only runtimes/host_runtime_capability from the captured capability object |

The runner loads its own original binding's backend store. It never accepts a
caller-provided lease ID. It snapshots and durably records the eligible pending
lease IDs and device cleanup phase under the original retirementId. Already
settled leases do not create new HTTP work. Issuing/uncertain entries without a
known leaseId remain visible and fail clean retirement; no guessed revoke, new
issue, renewed grant, inference, or automatic replay is permitted.

Device absence is confirmed clean. A present row must match original owner and
device and host_kind=phone. Capture its capability object and updated_at before
PATCH, preserve unrelated fields, and persist the CAS expectation before sending.
Zero returned rows/version conflict means pending/conflict, not success. An
explicit retry reconciles the original CAS phase; it cannot reread a newer host
registration and blindly withdraw that newer version. The original binding's
publication barrier remains held while this transaction is pending.

There is no retirement authorization path for catalog, issue, renew, provisioning,
heartbeat, registration, command execution, inbox/markRead, chat reads/writes,
timeline, hostCall, model inference or a caller-selected RPC/body. Ordinary
`GuguIOSCloudBroker` retains its existing Credentials provider unchanged.

## Ordering and durable outcomes

First seal/quiesce native execution and cancel its original transports/timers;
do not require a working ordinary broker to stop local work. The separate runner
then reconciles only the captured cleanup ledger. A known revoke/withdraw receipt
is retained before a late permit rejection; it cannot be attributed to a new
binding. Partial/unknown outcomes stay under their original transaction.

Completion succeeds only when local quiescence, all required checkpoint/revoke
results and original device withdrawal/absence are confirmed. Checkpoint failure
still attempts the known revoke and remains a reported failure, as in the current
settleModel contract. Missing authority, cold-store corruption, unknown issuing,
transport ambiguity, CAS conflict or failed native stop retains the barrier.
Constructing the cleanup object and reading its ledger perform no HTTP or replay.

Required offline controls include: cold start with no active publication; sealed
ordinary credentials rejected while permitted cleanup succeeds; old A cleanup
while B is current cannot touch B; wrong binding/retirement/operation/lease ID and
expired permits issue zero HTTP; permit changes during a held response; unknown
issue never reissues; device CAS conflict cannot withdraw a replacement; known
receipts survive late revocation; and ordinary catalog/issue/renew/hostCall cannot
use the cleanup provider. Real account/device cleanup remains A's execution.
