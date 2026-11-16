# Android account closure adapter (unwired)

Issue: https://github.com/GUYI-AI/gugu/issues/2821

The public contract remains `platform/accountClosure.ts`. `PhoneAccountClosureActions`
and the shared flow/cleanup controller signatures are unchanged. No Settings entry,
real account-closure request or HTTP contract is introduced here.

## Failed and expired preparation finalizer

`composeAndroidAccountClosure` wraps the native receipt transport. After the shared
cleanup calls `receipt.remove(scope)` for a confirmed `failed` or `expired` result,
it awaits `preparation.cancel(scope): Promise<void>`. This private adapter action
invokes Capacitor `GuguAccountClosure.cancelPreparation({ ownerId,
localOperationId }): Promise<{ cancelled: true }>` and validates the acknowledgement.
It releases only the preparation fence. Phone Agent settings remain disabled;
no Agent is restarted. `deleted`, a pending local erase and an unknown result keep
the fence. Cancellation errors retain failed cleanup custody and reject the
adapter call instead of reporting completion. The native guard requires the
captured scope, current local owner and an already removed receipt; it refuses
cancellation once erasure has begun. Captured receipts bind the preparation
generation; an old removed scope cannot release a later preparation of the same
account. The final native cancellation rechecks this generation under the auth
storage lock immediately before releasing the fence.

The already merged iOS adapter has no equivalent explicit finalizer at this
branch baseline. iOS alignment is coordinated separately; this branch does not
change iOS code or the public v0 interface.

## Verification status

TypeScript composition tests (10 cases) and repository typecheck passed.
Android Java compilation and all 128 JVM tests passed, including 15 new closure
cases. Whole-repository zero-warning ESLint, typecheck and source checks also
passed. The JVM run used an ignored compile-only web asset to generate Capacitor
configuration; it is not an application build or device acceptance. Protected
Android Keystore device tests and CI remain pending. This is a reviewable
implementation branch, not a release verdict.
