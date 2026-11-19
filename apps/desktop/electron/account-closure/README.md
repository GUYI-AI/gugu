# Desktop account-closure native custody

Refs #2776 and #2777. This module adds no Settings entry and sends no account-deletion HTTP request. The shared request composition must call local erase only after the server authoritatively reports `deleted`.

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
