/** Where a user message carries the digest of the native prompt it was sent as. The key predates Codex receipts: stored Hermes rows already carry it. */
export const HOST_PROMPT_HASH = 'gugu.hermesNativePromptSha256';

/**
 * A prompt receipt's `_meta` key: the agent took this input but keeps no record of it (a Codex `/goal` command becomes
 * a thread goal, not a user message). The host keeps the person's message in its own journal, so it is still there once
 * the turn settles from the record, after a reload and after a restart.
 */
export const UNRECORDED_PROMPT = 'guguUnrecorded';
