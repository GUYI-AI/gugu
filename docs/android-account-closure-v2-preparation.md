# Android trusted account closure V2

Refs #3150, #2942 and #2776. This change adds the independent `GuguAccountClosureV2`
Capacitor bridge and `nativeAndroidAccountClosureV2` adapter. Public types are the
desktop-owned types/flow `6dbede7` → `50fb032` → `9d32a08`; backend semantics
are frozen at gugu-supabase `e81f0885da3ab51bb8e04af9496bddb0d29512ac`.
The shared controller, Settings and renderer UI are separate changes. This source
change does not deploy backend code or open any production/dedicated-account gate.

## Native custody and admission

Policy comes from the packaged backend's V2 status route using committed native
Auth and an ordinary public anon key. Configuration uses the renderer's existing
environment resolver. A failed build removes stale generated configuration;
privileged and human tokens cannot ship as the public key. A policy failure rejects.
`available:false` closes new admission without removing existing pending custody.

Before registration or runtime effects, native captures original owner/SID,
installation, canonical device, backend, operation, native generation and exactly
32 CSPRNG receipt bytes. A new encrypted index stores discovery and all owner
records in one existing AndroidKeyStore AES-GCM/fsync/rename replacement. Records
use magic `0x47554332`, storage version 4, protocol version 2. Old V1 keys/formats
remain separate. Incompatible/corrupt private V2 storage fails closed, never mints
another capability. Another owner's bytes survive replacement unchanged.

Only safe snapshots cross the bridge: owner, opaque handle/local CAS revision,
server operation revision/challenge counter, preparation generation and fixed
retained-item names. Neither receipt, original SID, bearer, confirmation ID, native
installation nor backend address is exported. The renderer supplies no owner,
server result, generation pair, URL or confirmation intent. Native creates and
persists those intents itself. The ordinary V1 receipt API cannot read V2 storage.

## Effects and recovery

Nine public facade methods correspond to the common V2 native interface. Register,
challenge, prepare, confirm and cancel dispatches persist their intent before HTTP.
All requests use the original operation/receipt. HTTP has bounded payloads, strict
UTF-8, HTTPS, no redirects, cache or automatic retries. Failures expose fixed codes,
never raw bodies or token-bearing exceptions.

The phone adapter verifies the original handle, durably disables the original owner's
renderer host/device publication preferences and drains that publication before
calling native preparation. A failed preferences commit is an error; stale enabled
values cannot be presented as a successful pause. Cancellation never switches these
preferences back on. This uses the existing publication helper, not a V1 request or
receipt adapter.

Local preparation persists `captured -> preparing -> local_prepared`, revokes only
the original owner's grants, drains both native runtimes and rechecks native idle,
full scope and CAS. Runtime waits and HTTP do not hold the Auth monitor. A native
side-effect admission prevents a different owner/SID crossing stop dispatch.
Existing launch, grant and V1 preparation/cleanup paths honor the persisted V2 seal.
A stale V1 completion cannot resurrect its cancelled/replaced generation over V2.

Recovery discovers the original protected operation even without a live Auth
session. It verifies the existing registration marker without creating/migrating
another device identity. With B signed in, only B can be discovered/resolved;
A cannot adopt B's native session. Recovery calls only original receipt-result:
no register, resend, new prepare or new confirmation. An open result never clears
an unknown confirmation intent. A complete original `operation.confirmation`
rejected receipt can clear only its matching confirmation ID/challenge after a
durable native commit; a bare 422 cannot. The bridge then reports the fixed
verification error, and the seal still requires a separate cancellation ACK. Preparation response loss recovers the existing
server generation, which is durably committed before safe cancellation.

Cancellation releases only on `operation.state=closed_before_confirm`,
`operation.can_release_preparation=true`, `preparation.cancelled=true`, exact native
generation and matching known server generation. Unprepared cancellation requires
explicit server-generation null. The server's pre-registration tombstone prevents
late registration from reopening an operation. 404, 422, open, missing fields and
unknown outcomes never release custody. No cancellation automatically restarts an agent.

Trusted deleted results authorize only original-owner cleanup after native drain.
Auth retirement and the three fixed owner directories checkpoint independently;
crashes retry idempotent remaining steps. B's data, installation marker and
unattributed shared caches are retained. Finalization requires completed cleanup
and no live native Auth; it zeros the receipt but retains a permanent deleted-owner
tombstone. Late Auth/runtime writes for that deleted owner remain blocked.

## Validation evidence

A fixed 20-file production/test source snapshot was compiled with real JDK 21,
release 17, pinned JUnit and two processors: **92 tests passed** on 2026-11-19.
It covers protected index atomic failures/corruption, owner/SID/device/backend/CAS
isolation, signed-out result recovery, preparation response loss, unknown confirmation,
strict cancellation, drain admission and resumable cleanup. It does not exercise
Android Keystore, the actual Capacitor bridge, services or a live backend.

`AccountClosureV2NativeTest` adds actual Android JSON/Keystore/files cases using
isolated test contexts and local identities without HTTP. Its execution and full
Android build/device acceptance must be recorded separately; source presence is
not a pass. Current full-path attempts stopped at the mac1 resource guard before
completion. No App, Keystore, dedicated-account deletion or real-window pass is
claimed by the portable suite. Runtime gates and all production admission remain closed.
