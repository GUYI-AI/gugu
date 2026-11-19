# Desktop account-closure native custody

Refs #2776 and #2777. This module adds no Settings entry. The independent V2 native receiver sends only fixed V2 HTTP requests and permits scoped local erase only after a trusted original-operation result reports `deleted`. The older local-only receipt interface remains available to its existing callers; V2 does not use it to transport cloud capabilities.

The renderer uses the existing `AccountClosureNative` interface. A dedicated main-frame-only IPC accepts a bounded account/opaque-operation scope, not a path, a secret-store key, or a claim that native preparation succeeded. Native receipt capture requires the current main-process account. Subsequent access requires that captured context and the same account or a signed-out main. An unknown native identity and another account both reject access.

The existing backend bundle supplies its one `EncryptedAppSecretsStore` and message database. There is no plaintext or browser-storage fallback. A missing or insecure system key store rejects custody. The protected installation binding also binds the operation to the native profile and runtime home.

## Preparation and interruption

Preparation persists an operation-bound native fence, pauses account work and drains admitted work outside the auth-mutation barrier. It rechecks native identity and the fence generation before acknowledging preparation. Logical sessions removed from the visible list and late native start results remain part of the runtime exit proof. An unconfirmed teardown cannot become a successful empty drain.

Account changes are serialized only during the short credential mutation. Waiting for old native work does not hold that barrier or the lifecycle identity-transition queue. A stale A stop refuses to sign out B. Native preparation also checks the runtime ledger without killing a process or removing a ledger entry: another live or unverified owner and an unreleased A/unknown engine keep preparation unconfirmed. Known B records remain untouched.

After a failed or expired operation, composition explicitly removes its receipt and then cancels preparation. Cancellation keeps Agents paused; it never silently resumes them. The common UI/wiring change must supply the approved explicit restart action. Pending/deleted cleanup cannot cancel an erase fence.

## Local cleanup

Each named cleanup step is idempotent and checkpointed in the protected operation record. A pending step preserves the receipt. Completion does not remove the receipt; composition does so explicitly afterward.

Cleanup clears only the account's message cache, strictly attributed Agent credentials and roster rows, its native password-vault directory, its attributed diagnostic-log directories, and a matching native login mirror. A different login mirror rejects cleanup. Directory aliases reject removal. Password-vault sync and serialized writes must finish before its directory is removed. Log sinks move away and pending writes flush before their account directory is removed.

Workspace files, device settings, provider credentials, mixed/unattributed session history, unattributed diagnostic logs and runtime records remain. The result reports only fixed item names, never identifiers, paths or values. Renderer auth publication, renderer caches, subscriptions, the return-to-login transition, the real server contract and end-to-end account deletion belong to the following common wiring/UI changes.

## Independent V2 receiver

`account-closure:v2` accepts only safe native commands, a bounded local handle and the confirmation code/forfeit intent. It never accepts a URL, bearer, receipt, original SID, server result, claimed preparation or deletion proof. The existing backend bundle supplies the canonical encrypted store. One atomic encrypted envelope holds each original account/SID, random capability, native generation, pending effect and local CAS revision. Safe snapshots are projected through a positive field list. A separate unexposed local cleanup scope holds only a non-authorizing marker, so the legacy public receipt getter cannot read a V2 capability.

All active effects require the captured live owner/SID. The native identity barrier protects capture and intent/response checkpoints, not HTTP requests or runtime drains. A response arriving after B signs in cannot update A or clean B. Native generation, preparation server generation, local CAS revision and server operation revision are separate fields. Stale handles reject before effects.

Interrupted register, challenge, preparation or confirmation keeps the original intent. Recovery sends only the original capability-authenticated result request, including after Auth deletion or policy closure. Cold startup/Auth changes use that same receiver. It never registers, resends, prepares or confirms on recovery. Confirm uncertainty retains the original nonce and challenge generation. Under the maintainer's revised recovery rule, each explicit user click may issue one original-binding idempotent cancellation; a lost request/503 permits another explicit click, never an automatic loop. A 409/request_active blocks further cancellation and permits only original-result reads. Only a matching rejected confirmation or authoritative terminal ACK resolves the corresponding uncertainty. A bare 422, open result, missing operation or absent preparation cannot release the seal.

A cancellation ACK requires closed_before_confirm, operation.can_release_preparation=true, preparation.cancelled=true and the original native/server generations. An explicit unprepared cancellation may use the authoritative tombstone with server_generation=null; a missing operation itself grants nothing. Cancellation keeps work paused. A separate main-frame explicit-resume command requires the current owner's terminal cancelled record and no active/erasing fence. Its lifecycle-queued identity qualification invalidates earlier Auth permits before starting work, so an earlier drain cannot authorize a later credential swap over newly resumed work. Ordinary startup and reconciliation cannot invoke this intent. Successful deletion runs the existing named, idempotent local cleanup checkpoints, retains the capability through local-complete, and removes it only after the shared renderer finalizes the original account. No model request, automatic destructive retry or V1 fallback is part of this module.

Windows preparation deliberately rejects any remaining relevant process-tree ledger: checking a root PID is not evidence that its children exited. The actual owning stop must retire its own record. Windows native acceptance and real macOS keychain acceptance must be reported separately from mock-keychain functionality.

## Permanent IM write retirement

A trusted V2 deleted result retires its original account on the canonical SQLite connection before local cleanup proceeds. The forward migration adds an account retirement table. Retirement and the message/index/access/range/cursor purge commit together. Every ingest transaction checks the durable account fence before any batch write, so a second renderer, an already-captured batch, or a reopened connection cannot restore the deleted account. The check is once per batch, not a trigger on each message.

The native retirement function is outside the RPC controller's method map. Renderer cache clearing cannot assert retirement or remove an existing fence. Ordinary account clearing still supports login/repopulation; only the trusted native deleted receiver permanently retires an account. A purge/retirement failure preserves the original deletion capability and does not complete local finalization.
