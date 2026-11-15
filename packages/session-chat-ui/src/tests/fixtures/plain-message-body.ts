import type { ChatCommands } from '@session-chat/commands';

/**
 * The host of these contract tests: what an agent sent to people is drawn by the host's MessageBody into a slot
 * (`onMessageBodyMount`). Here the slot just shows the message's text, so a test reads the words where they land.
 */
export const plainMessageBody: NonNullable<ChatCommands['onMessageBodyMount']> = ({ root, message }) => {
  root.textContent = message.content ?? '';
  return () => { root.textContent = ''; };
};
