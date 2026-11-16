# AI reviews for me

The permission menu can route requests for additional authority to the harness's native AI reviewer. Actions already allowed inside the selected workspace boundary do not need another review. Denied actions retain their reason in the session process. Repeated denials can stop the turn and require the user's help.

## Harness requirements

- **Codex:** native Auto-review, with `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"`, and `approvals_reviewer = "auto_review"`. Its internal reviewer model is `codex-auto-review`; that model is excluded from main-model selectors. The app-server permission channel is verified on CLI 0.156.1 and later. Switching to another permission tier explicitly restores the user reviewer. An unavailable or timed-out review does not authorize the requested action; native cancellation remains authoritative.
- **Claude Code:** native `auto`, with `CLAUDE_CODE_AUTO_MODE_MODEL=claude-haiku-5-5`. The selected session executable must be at least 2.1.302. Root SDK and bridge package versions do not establish that requirement. Old or unknown executable versions hide the menu entry without adding a warning. Supported main models are Anthropic Opus, Sonnet 4.6 and later, Haiku 5.5, and Fable. Other vendors' models on the Claude Code harness do not expose this permission tier.

The app preserves the chosen host executable. This feature does not install or upgrade a shared CLI or SDK. Reviewer requests use the existing connection and normal usage accounting; there is no separate approval surcharge in the client.

## Gateway rollout prerequisite

Gateway-backed Codex sessions additionally require a reachable `codex-auto-review` model on the Responses route. A UI option alone cannot make that gateway service available.

Ship the client that filters the internal reviewer from main-model selectors before enabling that reviewer on a production gateway. The release coordinator must then ask the gateway team to enable it and verify the gateway-backed approval flow. Until that prerequisite is met, production gateway-backed Codex AI review is unavailable and can return HTTP 503. Staging availability does not prove production availability. This client change does not modify a gateway or its configuration.

## Official references

- [Codex Auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- [Codex sandbox and approval settings](https://learn.chatgpt.com/docs/sandboxing#configure-defaults)
- [Claude permission modes and classifier selection](https://code.claude.com/docs/en/permission-modes#choose-the-classifier-model)
