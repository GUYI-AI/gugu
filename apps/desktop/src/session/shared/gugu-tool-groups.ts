import z from 'zod';

/**
 * 咕咕内置那台 MCP(`gugu`)的工具按组开关(owner 11-10 msg:6fcbcd7c「built in mcp 配置也可以做成用户可以配置的」)。
 * 一组 = 一个能力域;关掉的组照常注册、标成不可用(acp-engine-utils `switchGuguTools`):原生清单和 catalog 都不列,按名调被拒;
 * 开关一变,已连上的会话收到 tools/list_changed。
 *
 * 锁住的组不可关:投递信封让 agent 用 message_send / session_message 回话,平台提示词让它经 catalog_* / guide_* 找工具和说明 ——
 * 关掉它们,agent 收得到消息却回不了、找不到工具。
 */
export const GUGU_TOOL_GROUPS = [
  { id: 'messages', locked: true, match: /^(message_|topic_|group_|profile_|contact_friend$|owner_friends_list$|activity_chat_list$)/ },
  { id: 'sessions', locked: true, match: /^(session_|activity_list$|activity_context$)/ },
  { id: 'catalog', locked: true, match: /^(catalog_|guide_)/ },
  { id: 'devices', locked: false, match: /^device_/ },
  { id: 'projects', locked: false, match: /^project_/ },
  { id: 'library', locked: false, match: /^library_/ },
  { id: 'schedules', locked: false, match: /^schedule_/ },
  { id: 'apps', locked: false, match: /^(app_|widget_send$|widget_get$)/ },
  { id: 'web', locked: false, match: /^web_search$/ },
  { id: 'passwords', locked: false, match: /^password_/ },
] as const;

export type GuguToolGroupId = (typeof GUGU_TOOL_GROUPS)[number]['id'];
type SwitchableGroupId = Extract<(typeof GUGU_TOOL_GROUPS)[number], { locked: false }>['id'];

/** 一个工具属于哪组;对不上任何一组 ⇒ undefined(单测钉着宿主注册的每个工具都有组,新工具忘了归组会在那里红)。 */
export function guguToolGroupOf(name: string): GuguToolGroupId | undefined {
  return GUGU_TOOL_GROUPS.find((group) => group.match.test(name))?.id;
}

const switchableIds = GUGU_TOOL_GROUPS.filter((group) => !group.locked).map((group) => group.id) as [SwitchableGroupId, ...SwitchableGroupId[]];

/** 存在那台机器 KV 里的那一份:关掉的组。写的时候严格,锁住的组、认不出的 id 写不进来。 */
export const guguToolsOffSchema = z.array(z.enum(switchableIds));
export type GuguToolsOff = z.infer<typeof guguToolsOffSchema>;

/**
 * 读存着的那一份:认不出的 id(别的版本写的、改过名的)和锁住的组直接丢掉。每个 MCP 连接、每次建会话都读它,
 * 读不懂一个 id 不能让所有会话都起不来。
 */
export function guguToolsOffFromStored(stored: unknown): GuguToolsOff {
  if (!Array.isArray(stored)) return [];
  return stored.filter((id): id is SwitchableGroupId => (switchableIds as readonly unknown[]).includes(id));
}
