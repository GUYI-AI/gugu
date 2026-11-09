# Build-channel password Beta access

The single shared `PASSWORD_BETA_ENABLED` constant in `@gugu/core/shared/passwordBeta` reads only
the build-time `__GUGU_TIER__` literal. It is true exactly for `beta`, false for production, missing
or other tiers. Vite already defines this literal for desktop main and renderer. UI visibility,
native entrypoints and storage eligibility must use this same constant. No account allowlist,
runtime environment/configuration switch or request field can enable the production build.

Construct `createBetaPasswordAccess(host)` once from the fixed native host. Bind `host.readPolicy`
to the existing `ServicePermissionPolicyStore.read` and `host.toolScope` to the shared native
scope helper. The host supplies its actual account/app lifetime signal; this preserves ordinary
authenticated identity boundaries without restricting Beta to a designated account.

The returned `acquireFeatureGuard(operation, signal)` is the channel eligibility provider for
the storage constructor. It does not certify seven production protection facts. Pass the returned
`createPermission(context, targetGetter)` to the native browser factory. Context contains actual
raw session/installation/device identity, original grant signal and a synchronous native check.
The getter reads the current private surface/registry, never tool-supplied caller identity.

Each request/fill/submit/handoff stage freshly reads common policy and preserves locked user-denial
precedence. Even an allow rule returns only `requiresPersonConfirmation: true`. The existing
approval authority must still show the person decision and claim the single submission on every
use. This module has no approval, capability, secret reader, log writer or submission counter.
The final native fill/submit checks remain mandatory. Provider errors become fixed permission errors.

The full production `PasswordFeatureReadiness` path is unchanged and remains unavailable without
actual proofs. Complete cleanup, additional revocation sources, complete encrypted audit and
A06–A10 hardening are deferred for this Beta, not reported as passed. Policy reads do not promise
zero delay from a cloud rule commit to a local action. Real account/grant aborts cancel guards;
native identity and target checks run again after waits and at final synchronous gates.

This increment alone does not establish that the complete native path keeps passwords out of
Agent context and all logs. The main integration must exercise those two boundaries and verify
that the production UI does not show the password entrypoint before the Beta is accepted.
