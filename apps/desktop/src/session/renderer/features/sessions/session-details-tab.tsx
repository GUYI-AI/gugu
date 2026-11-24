import { observer } from 'mobx-react-lite';
import { lazy, Suspense } from 'react';
import { Info } from '@/lib/icons';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { TabResource } from '../tabs/core/tab-provider';
import { createTabProvider } from '../tabs/core/tab-provider-registry';
import { registeredTabView } from '../tabs/core/tab-views';
import { GenericTabDragPreview, GenericTabItem } from '../tabs/tab-bar/generic-tab-item';

// The avatar reads the agent bindings, whose imports lead back to the registry that registers this provider: loaded lazily.
const SessionTabAvatar = lazy(() => import('./session-tab-avatar').then((module) => ({ default: module.SessionTabAvatar })));
const detailsMark = (sessionId: string) => <Suspense fallback={<Info size={14} />}><SessionTabAvatar sessionId={sessionId} size={16} /></Suspense>;

export type SessionDetailsState = { sessionId: string };
export class SessionDetailsResource implements TabResource {
  constructor(readonly state: SessionDetailsState) {}
  dispose() {}
}

/**
 * 第 16 版「详情」页签(#25 #44):名片里「详情 ›」打开它,开在对话旁边。一条会话只有一枚(resourceKey 固定),
 * 换了会话就跟着换(state 里的 sessionId)。名字和群 / 私聊的详情页签同一个「详情」。
 */
export const sessionDetailsTabProvider = createTabProvider<'session-details', SessionDetailsState, SessionDetailsResource>({
  kind: 'session-details',
  resourceKey: () => 'session-details',
  isPersistent: () => false,
  initialize: (entry) => new SessionDetailsResource(entry.state),
  dispose: (_entry, resource) => resource.dispose(),
  TabBarItem: observer(({ tab, host, ctx }) => <GenericTabItem tab={tab} host={host} ctx={ctx} label={translateSessionMessage('details.title')} preSlot={detailsMark(tab.resource.state.sessionId)} />),
  TabBarItemDragPreview: observer(({ tab }) => <GenericTabDragPreview label={translateSessionMessage('details.title')} preSlot={detailsMark(tab.resource.state.sessionId)} />),
  TabContent: registeredTabView('session-details'),
});
