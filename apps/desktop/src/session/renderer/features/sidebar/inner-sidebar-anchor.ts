import { observable } from 'mobx';

// #2548 内层侧栏挂在哪个对话上。打开一个用户群或一个项目(它的项目群)就出现;从这一列里点开一个智能体,
// 正看着的是那条会话,这一列照旧留着(点别的、开私聊、开不在这个群里的会话就收起)。
// #2574 这一列说的是「这个对话里还有谁在干活」:有子智能体的独立智能体也有这一列(开它就是开它的会话)。

/** 群,或项目(项目群的 chat id)。 */
export type InnerSidebarRoomAnchor = { kind: 'group' | 'project'; chatId: string };

/** 一个有子智能体的独立智能体(`agentUserId`);`chatId` = 和它的私聊,左边列表里它那一行。 */
export type InnerSidebarAgentAnchor = { kind: 'agent'; chatId: string; agentUserId: string };

/** 内层侧栏正对着的对话。 */
export type InnerSidebarAnchor = InnerSidebarRoomAnchor | InnerSidebarAgentAnchor;

/**
 * 内层侧栏此刻挂在哪个对话上(没有 = null;收起着也照旧挂着)。左边列表据此让那个群 / 项目 / 智能体那一行保持高亮 —— 从这一列点开一个智能体时,
 * 正看着的是那条会话,列表里却没有它自己的一行;列表顶上的搜索据此先搜这个群。InnerSidebar 写。
 */
export const innerSidebarChat = observable.box<InnerSidebarAnchor | null>(null, { deep: false });

/** 此刻正看着什么(导航的当前视图,读成内层侧栏需要的样子)。 */
export type InnerSidebarView =
  /** 对话块。`chatKind` 读自壳那份对话摘要,还不知道 = null;`projectGroup` = 它是某个项目的项目群。 */
  | { kind: 'chat'; chatId: string; chatKind: string | null; projectGroup: boolean }
  /** 项目块;`chatId` = 这个项目绑的项目群,没绑(或还没读到)= undefined。 */
  | { kind: 'project'; chatId: string | undefined }
  | { kind: 'session'; sessionId: string }
  | { kind: 'other' };

/** 这个视图自己就是一个群 / 项目:内层侧栏挂在它上面;私聊、别的视图 = null。 */
export function viewAnchor(view: InnerSidebarView): InnerSidebarRoomAnchor | null {
  if (view.kind === 'chat') {
    if (view.projectGroup) return { kind: 'project', chatId: view.chatId };
    return view.chatKind === 'group' ? { kind: 'group', chatId: view.chatId } : null;
  }
  if (view.kind === 'project') return view.chatId ? { kind: 'project', chatId: view.chatId } : null;
  return null;
}

/**
 * 换了视图之后内层侧栏挂在哪:视图自己是群 / 项目就挂它;看的是一条会话、且它列在上一次那一列里,就还挂着上一次的;
 * 不然它是一个有子智能体的独立智能体的会话,就挂那个智能体(#2574);其余收起。
 * `listedIn(anchor, sessionId)` = 这条会话列在那一列的「智能体」里;`agentAnchorOf(sessionId)` = 这条会话开出来的那个智能体的一列,没有 = null。
 */
export function followInnerSidebar(
  previous: InnerSidebarAnchor | null,
  view: InnerSidebarView,
  listedIn: (anchor: InnerSidebarAnchor, sessionId: string) => boolean,
  agentAnchorOf: (sessionId: string) => InnerSidebarAnchor | null
): InnerSidebarAnchor | null {
  const own = viewAnchor(view);
  if (own) return own;
  if (view.kind !== 'session') return null;
  if (previous && listedIn(previous, view.sessionId)) return previous;
  return agentAnchorOf(view.sessionId);
}
