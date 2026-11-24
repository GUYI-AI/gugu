import { observable } from 'mobx';

// #2548 内层侧栏挂在哪个对话上。打开一个用户群或一个项目(它的项目群)就出现;从这一列里点开一个智能体,
// 正看着的是那条会话,这一列照旧留着(点别的、开私聊、开不在这个群里的会话就收起)。
// 一屏几块时这一列是这一屏的,不是焦点那一块的:它挂的群 / 项目还在屏上,焦点去了旁边没有这一列的一块(私聊、别的会话),
// 它照旧挂着 —— 在哪一块里按下不挪动任何一块。
// #2574 智能体锚(有子智能体的独立智能体)只剩手机会话页的「智能体」选单在用;桌面私聊没有这一列(传 `agentAnchorOf = () => null`)。

/** 群,或项目(项目群的 chat id)。 */
export type InnerSidebarRoomAnchor = { kind: 'group' | 'project'; chatId: string };

/** 一个有子智能体的独立智能体(`agentUserId`);`chatId` = 和它的私聊,左边列表里它那一行。 */
export type InnerSidebarAgentAnchor = { kind: 'agent'; chatId: string; agentUserId: string };

/** 内层侧栏正对着的对话。 */
export type InnerSidebarAnchor = InnerSidebarRoomAnchor | InnerSidebarAgentAnchor;

/**
 * 内层侧栏此刻挂在哪个对话上(没有 = null;收起着也照旧挂着)。左边列表据此让那个群 / 项目 / 智能体那一行保持高亮 —— 从这一列点开一个智能体时,
 * 正看着的是那条会话,列表里却没有它自己的一行;全局搜索据此提供「当前群」筛选。InnerSidebar 写。
 */
export const innerSidebarChat = observable.box<InnerSidebarAnchor | null>(null, { deep: false });

/** 此刻正看着什么(导航的当前视图,读成内层侧栏需要的样子)。 */
export type InnerSidebarView =
  /** 对话块。`chatKind` 读自壳那份对话摘要,还不知道 = null;`projectGroup` = 它是某个项目的项目群。 */
  | { kind: 'chat'; chatId: string; chatKind: string | null; projectGroup: boolean; roomChatId?: string }
  /** 项目块;`chatId` = 这个项目绑的项目群,没绑(或还没读到)= undefined。 */
  | { kind: 'project'; chatId: string | undefined }
  /** A task's page; `projectChatId` = the group of the project it belongs to, if that project has one. */
  | { kind: 'session'; sessionId: string; projectChatId?: string }
  | { kind: 'other' };

/** 这个视图自己就是一个群 / 项目:内层侧栏挂在它上面;私聊、别的视图 = null。 */
export function viewAnchor(view: InnerSidebarView): InnerSidebarRoomAnchor | null {
  if (view.kind === 'chat') {
    // A topic is its own conversation, but the column it lives in is its source line's (`roomChatId`, chatViewOf).
    const room = view.roomChatId ?? view.chatId;
    if (view.projectGroup) return { kind: 'project', chatId: room };
    return view.chatKind === 'group' ? { kind: 'group', chatId: room } : null;
  }
  if (view.kind === 'project') return view.chatId ? { kind: 'project', chatId: view.chatId } : null;
  return null;
}

/**
 * 内层侧栏挂在哪:视图自己是群 / 项目就挂它;不然认这一屏的入口那一列(`entry`,screen-layout 记着的、和这一屏一起收起摆回的那个群 /
 * 项目 / 独立智能体):看的会话列在那一列里就挂它;不然它是一个有子智能体的独立智能体的会话,就挂那个智能体(#2574);
 * 再不然入口那个对话还在这屏上,就还挂着它;再不然这条会话属于一个有项目群的项目,就挂那个项目;其余收起。❌ 记「上一次挂在哪」:切走再回来,摆回来的是哪一屏,挂的就是它的入口。
 * `listedIn(anchor, sessionId)` = 这条会话列在那一列的「智能体」里;`agentAnchorOf(sessionId)` = 这条会话开出来的那个智能体的一列,没有 = null;
 * `onScreen(anchor)` = 那个对话此刻是这屏的一块。
 */
export function followInnerSidebar<A extends InnerSidebarAnchor>(
  entry: A | null,
  view: InnerSidebarView,
  listedIn: (anchor: A, sessionId: string) => boolean,
  agentAnchorOf: (sessionId: string) => A | null,
  onScreen: (anchor: A) => boolean
): InnerSidebarRoomAnchor | A | null {
  const own = viewAnchor(view);
  if (own) return own;
  if (view.kind === 'other') return null;
  if (view.kind === 'session') {
    if (entry && listedIn(entry, view.sessionId)) return entry;
    const agent = agentAnchorOf(view.sessionId);
    if (agent) return agent;
  }
  if (entry && onScreen(entry)) return entry;
  // A task that belongs to a project hangs on its project's column whatever it was opened from (a rail avatar, a list its
  // entry does not show it in): with no column there would be no restore button either (yangchichi 11-24).
  return view.kind === 'session' && view.projectChatId ? { kind: 'project', chatId: view.projectChatId } : null;
}
