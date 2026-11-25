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

Executable source commit `a950414de8c275e665e5192e02e3031827f88e81`, tree
`69bec8635b76a158fa0b3e1039860a8d55242b02`, was verified on 2026-11-19:

- A fixed 20-file production/test snapshot passed **107 portable JUnit tests**
  with real JDK 21, release 17 and pinned JUnit. The full App Gradle JVM suite
  passed **208 tests**, including those portable cases, with no failures/errors/skips.
- Ten focused renderer test files passed **83 Vitest cases**. The official
  `pnpm android:build` and App instrumentation APK build completed.
- The same App and test APKs installed on an isolated API34 AVD. All **7 actual
  Android JSON/Keystore/files/pause-recovery cases** passed in 2.587 seconds using
  local synthetic identities. The real App cold-started in 1,982ms and its native
  login screen was inspected. Owned processes and private ADB ports were closed.

App APK SHA-256: `23e8246529943d9131693a556c9b584842465f9b315e98bf8ae5f26aa49b2f0a`.
Test APK SHA-256: `8661ab0d49598a4fb0cad0fea73620571471cbab131d0c0e9b89e4fb8b3084e7`.

The root `assembleDebugAndroidTest` invocation subsequently failed in the Cordova
plugin's own Kotlin duplicate-class check, tracked as #3208; the successful App
task and its actual 7-case execution are recorded separately. Use the scoped
`:app:assembleDebugAndroidTest` task to reproduce the App test package.

Live-backend account deletion and the later single-dialog renderer integration
remain separate acceptance boundaries. This local run used no live backend or
real account, and does not establish end-to-end deletion or production admission.
