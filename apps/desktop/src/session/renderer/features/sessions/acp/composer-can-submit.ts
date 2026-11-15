/**
 * Whether the task composer's Send is live (#2348). Send means "start a turn" when the prompt is ready, and "queue behind
 * the running turn" while the agent works — the same input Enter already queues — so a running agent must not grey it out.
 * A message edit or a revert in progress still holds Send, as does an empty draft, an attachment still waiting, or a model
 * that needs membership before the next turn.
 */
export function composerCanSubmit(input: {
  promptReady: boolean;
  isWorking: boolean;
  reverting: boolean;
  editingMessage: boolean;
  queuesOffline: boolean;
  hasDraft: boolean;
  attachmentWaiting: boolean;
  membershipLocked: boolean;
}): boolean {
  const admits = input.promptReady || (input.isWorking && !input.reverting && !input.editingMessage) || input.queuesOffline;
  return admits && input.hasDraft && !input.attachmentWaiting && !input.membershipLocked;
}
