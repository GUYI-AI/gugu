# iOS account-closure adapter

Refs #2777, #2816, #2720.

`createIOSAccountClosureFlow` supplies the existing shared phone controller with
owner-bound `prepareIOSSignOut`, native owner retirement, and protected receipt
storage/local erasure. Its server actions are injected functions; this module
contains no account-closure endpoint, request payload or Settings entry.

The composition writes only owner/operation metadata before submission. Receipt
capture waits for native encrypted storage and the stable metadata journal before
exposing a result. A restored operation queries the saved receipt and never
repeats live-login cleanup or an unknown submission. Only explicit `retry_wait`
permits a retry of the same operation with its existing receipt. Another active
account cannot open that recovery flow.

The common controller retains receipts while local erasure is pending and removes
them after completion, or without erasure for failed/expired results. If receipt
removal succeeds but journal removal is interrupted, a restart conservatively
stays unconfirmed: it neither submits again nor erases without a receipt. This
boundary requires explicit future recovery handling; it is not reported as done.

Verification uses deterministic native/server substitutes. Real App account-A
closure followed by account-B isolation remains unverified before shipping;
real account-closure APIs are not connected here.

The scope journal uses the WebView's localStorage. If the system clears that
metadata after submission but before completion, restart cannot locate the old
operation: its native receipt becomes orphaned and a new operation ID can be
created for another submission. This boundary is UNVERIFIED; live backend APIs
are not connected and the effects of duplicate requests are unknown.

A failed scope-journal write currently appears as unconfirmed even though no
request was submitted. Presentation of that state belongs to the future UI
integration; this adapter adds no entry point.
