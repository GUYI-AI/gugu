# Native chat source lineage

Refs #1877. A continued Pi context keeps the chat sources that contributed to its
transcript. A current owner credential is not proof of the Agent's membership.

`GuguIOSSourceAccess.includeChat` atomically records a chat on the current input
and the native Agent registry context. A later turn in the same session/epoch
checks both sets. Unreadable lineage and a mismatched stored Agent identity fail
closed; an absent set is valid for a new context that has not read any chat.

Authorization checks the exact native owner/installation, current cloud Agent
owner/device, then each source chat through the existing Agent-as
`list_member_ids` operation. It rechecks the native epoch and registry source set
after asynchronous reads. A source set changed during that check requires a new
explicit check; it is not silently treated as empty.

The production backend supplies this authority to the scheduler and in-process
host. The model request is checked before dispatch and again before its reply
reaches Pi. Timeline reads check sources before projection and before returning
projected data to the caller. The communication core checks sources before work
and before returning successful data or a cached message receipt. Rules reads
also become sources. A known outbound write receipt is durably recorded before
the final data check, even if access is revoked before its delivery.

The optional in-process callback exists for isolated core fixtures; the native
service always installs the real source authority. It is not a renderer option.
These guards do not complete native inbox admission, Pi communication tools,
private attachment access or a cloud command pump. The public readiness and
capability flags remain closed. This slice does not change the packaged runtime
asset or its hash.

The targeted synthetic drivers cover APFS lineage across continued turns,
revocation and Agent moves, a source-set change during a held read, foreign-owner
zero-side-effect rejection, corrupt lineage, retirement during authorization,
late history-read revocation, known write custody, and actual Pi/JSC model
dispatch/callback/cancellation barriers. Test results are supplied separately;
source presence alone does not establish a passing run or an iOS App result.
