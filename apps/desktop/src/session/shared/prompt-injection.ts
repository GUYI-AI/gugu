/** 多行怎么写进 TUI 只看这一家的声明(`promptInput.multiline`),❌ 按引擎名特判。 */
export function buildPromptInjectionPayload(args: {
  text: string;
  forceBracketedPaste?: boolean;
  multilineEncoding?: 'bracketed-paste' | 'plain';
}): string {
  const trimmed = args.text.trim();
  const hasMultilinePayload = trimmed.includes('\n');
  const shouldUseBracketedPaste = args.forceBracketedPaste
    || (args.multilineEncoding !== 'plain' && hasMultilinePayload);
  if (!shouldUseBracketedPaste) return trimmed;
  return `\x1b[200~${trimmed}\x1b[201~`;
}

/** The group a session works in (sessions.chat_id), and its directory on this machine. No group = no block. */
export type SessionpageGroupContext = {
  groupChatId: string
  /** The session's cwd on this machine: one of the group's folders, or a worktree / subfolder of one. */
  path: string
  /**
   * #2347 — whether this session's agent is confirmed to sit in the group. Joining happens when the cloud identity
   * lands and can be refused (a full group), so only a landed identity whose roster records the group is `member`.
   */
  membership: 'member' | 'unconfirmed'
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildSessionpageGroupContextBlock(input?: SessionpageGroupContext): string {
  const groupChatId = input?.groupChatId.trim()
  if (!input || !groupChatId) return ''
  const cwd = input.path.trim()
  // 集体记忆对账第 1 条：群里是「在本群生出来的会话」，这是入群那一步做的事（[[agent-provisioning]]）。派你的、你派的
  // 会话不一定在 —— session_spawn 能点名别的群、起在别的机器上（#6883 / #6894，D-29），那时 spawn 回给派它的会话的
  // message_route 就是 session_message。所以这里只写读得出来的那一半，❌ 再断言「派你的会话也在群里、之后在群里回」。
  // The path is only this machine's: the block goes to the owner's own agent, never to the group.
  return `<gugu_group_context>
<group chat_id="${escapeXml(groupChatId)}"${cwd ? ` cwd="${escapeXml(cwd)}"` : ''} />
${input.membership === 'member' ? MEMBER_GROUP_TEXT : UNCONFIRMED_GROUP_TEXT}
session_message reaches one session point-to-point and appears in no chat. Inside this group exactly two things belong there: a session outside this group — one born in another group or on another machine, even one you spawned or the one that spawned you — and content this group must not see, such as a credential.
</gugu_group_context>
`
}

const MEMBER_GROUP_TEXT = 'This session works in the group above. Every session started in this group is already a member of it; nobody needs an invitation. When talking to another session here, default to that group: call message_send on the chat_id above, naming whoever should act in to_user_ids, so the collaboration is visible where the work lives. That covers the whole exchange, not just the hand-off.'
const UNCONFIRMED_GROUP_TEXT = 'This session works in the group above, but is not confirmed as a member: sessions started in a group join it when their identity is set up, and joining can be refused, for example when the group is full. You are a member only if profile_whoami lists this chat_id in your groups. If it does, default to that group with message_send, naming whoever should act in to_user_ids. If it does not, you are not in the group: say so plainly whenever it matters, never claim to be a member, and reach other sessions here with session_message.'
