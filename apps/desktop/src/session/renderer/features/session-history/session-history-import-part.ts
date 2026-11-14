import type { SessionHistorySource, SessionHistoryStatus } from '@shared/core/session-history/session-history';

/** 会话历史这一页的两样筛选;'all' = 这一样不筛。 */
export type SessionHistorySourceFilter = SessionHistorySource | 'all';
export type SessionHistoryStatusFilter = SessionHistoryStatus | 'all';

/** 进会话历史时停在哪一部分:只管这一次进来(转瞬参数,离开即作废),之后照旧由页面自己的筛选说了算。 */
export type SessionHistoryViewParams = {
  source?: SessionHistorySourceFilter;
  status?: SessionHistoryStatusFilter;
};

/**
 * 会话历史的导入那一部分 = 全部来源里还没导入的(筛选菜单「全部来源 · 未导入」)。
 * #2548 侧栏一张表、还没有任务时的「导入以前的会话」开的就是它;本机有没有可导入的,也按同一个状态问。
 */
export const SESSION_HISTORY_IMPORT_PART = { source: 'all', status: 'not-imported' } as const satisfies SessionHistoryViewParams;
