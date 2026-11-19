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

export type SessionpageProjectContext = {
  projectId?: string | null
  projectName?: string | null
  projectPath?: string | null
  groupChatId?: string | null
  groupName?: string | null
  /**
   * #2347 — whether this session's agent is confirmed to sit in the project group. Joining happens when the
   * cloud identity lands and can be refused (a full group), so only a landed identity whose roster records the
   * group is `member`. Anything else, including an omitted value, is `unconfirmed`: the block never claims it.
   */
  membership?: 'member' | 'unconfirmed'
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function buildSessionpageProjectContextBlock(input?: SessionpageProjectContext): string {
  if (!input) return ''
  const projectId = input.projectId?.trim()
  const groupChatId = input.groupChatId?.trim()
  if (!projectId || !groupChatId) return ''
  const projectName = input.projectName?.trim() || projectId
  const groupName = input.groupName?.trim() || projectName
  const path = input.projectPath?.trim()
  // A project's id is its project group (account-level, the same on every device); `projectId` is only this machine's
  // folder binding and never reaches the agent. Built on every start, so a resumed session reads the same id.
  // 集体记忆对账第 1 条：群里是「在本项目生出来的会话」，这是入群那一步做的事（[[agent-provisioning]]）。派你的、你派的
  // 会话不一定在 —— session_spawn 能点名别的项目、起在别的机器上（#6883 / #6894，D-29），那时 spawn 回给派它的会话的
  // message_route 就是 session_message（session-orchestration.ts spawn 的 message_route）。所以这里只写读得出来的那一半，
  // ❌ 再断言「派你的会话也在群里、之后在群里回」：跨项目的子会话照那句在自己的项目群里回，派它的会话不在群里，永远收不到。
  return `<gugu_project_context>
<project id="project:${escapeXml(groupChatId)}" name="${escapeXml(projectName)}"${path ? ` path="${escapeXml(path)}"` : ''} />
<project_group chat_id="${escapeXml(groupChatId)}" name="${escapeXml(groupName)}" />
${input.membership === 'member' ? MEMBER_GROUP_TEXT : UNCONFIRMED_GROUP_TEXT}
session_message reaches one session point-to-point and appears in no chat. Inside this project exactly two things belong there: a session outside this group — one born in another project or on another machine, even one you spawned or the one that spawned you — and content this group must not see, such as a credential.
</gugu_project_context>
`
}

const MEMBER_GROUP_TEXT = 'This session belongs to the project and project group above. Every session born in this project is already a member of that group; nobody needs an invitation. When talking to another session here, default to that group: call message_send on the chat_id above, naming whoever should act in to_user_ids, so the collaboration is visible where the project lives. That covers the whole exchange, not just the hand-off.'
const UNCONFIRMED_GROUP_TEXT = 'This session belongs to the project above. Its project group is the chat above, but this session is not confirmed as a member: sessions born in this project join it when their identity is set up, and joining can be refused, for example when the group is full. You are a member only if profile_whoami lists this chat_id in your groups. If it does, default to that group with message_send, naming whoever should act in to_user_ids. If it does not, you are not in the group: say so plainly whenever it matters, never claim to be a member, and reach other sessions here with session_message.'
