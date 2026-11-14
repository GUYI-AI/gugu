# Empty project path and original provision recovery

Refs #1877. Preserve A's original HTTP/command error evidence and original
request/client/operation/provision/Agent/DM identifiers. This patch does not reset
an error command, edit a cloud row directly or mint a replacement Agent.

Shared semantics: `deviceCommandRuntime.ts` normalizes `payload.project_path`
through its text helper. Android `phone-agent-host.mjs` rejects an input path
only when it is nonempty and differs from the App's private root. Thus an absent,
null or whitespace-only path selects the native private root. A nonempty foreign
path remains unsupported before native session construction. Nonstrings reject.

The old command is a real terminal error. The existing provision saga must
settle it before the failed member can receive an explicit retry slot:

1. Apply this patch and the earlier f288 auth-action fix. Reuse the same private
   root, published owner binding, request UUID and identical prompt/model input.
2. Configure/open the same native service and run the original probe.create.
   If its command is still error, the provisioner reads that original command,
   calls `settle_agent_provision_terminal(originalProvisionId)`, verifies the
   same Agent/command binding and phase=failed, and returns `provision_failed`.
   This call creates no native session, model request or new command.
3. Explicitly run probe.create again with the exact same original UUID/input.
   The existing operation/provision is read as failed; `claim_provision_slots`
   receives retry=[originalProvisionId]. Only a granted preparing row may call
   `prepare_agent_provision` again.
4. The server's established same-Agent retry protocol reuses the original Agent
   and DM and creates a linked successor agent.create command. Its UUID is
   allocated by the server; the client neither chooses a replacement UUID nor
   resets the original error command. Preserve both command IDs for audit.
5. The successor command executes with the corrected blank-path semantics. The
   original operation's stable initial-task ID remains unchanged. Continue the
   actual Pi/approval/timeline/lease-cleanup probe. A second server failure remains
   a failure; the patch never loops or automatically retries it.

If the provision was already settled failed before step 2, that explicit same-ID
call proceeds directly through the existing failed-member retry branch. If the
Agent was removed or the server has no retry capacity, propagate that outcome;
do not recreate identity or bypass claim.

SSOT references, read-only local source:
`apps/mobile/runtime/phone-agent-host.mjs` startAgentSession,
`packages/core/src/local/agent/deviceCommandRuntime.ts` handleAgentCreateDeviceCommand,
`apps/desktop/src/lib/agentProvision.ts` runClaimedMember/runSingleProvision,
and the cloud foundation's prepare_agent_provision retry-reuse branch.
The SQL explicitly preserves Agent/DM while replacing create_command_id after
the old command is error. Keeping the old command ID as the active retried
command would contradict that existing protocol.
