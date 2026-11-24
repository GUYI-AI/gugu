import { useRef } from 'react';
import { replica, useReplicas, type Reading } from '@/lib/replica';
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source';
import { rpcOn } from '@renderer/lib/ipc';
import type {
  SessionHistoryDirectoryPage,
  SessionHistoryDirectoryParams,
} from '@shared/core/session-history/session-history';

// spec session-page「会话历史」(#6083):面板的数据源。每台问得到的机器各读各的(那台机器上同一个 `sessionHistory`
// 控制器,读的是它的库与各家原件),由面板合并。筛 / 排 / 聚合都在主进程做完了,这里**不排序、不分组**。
//
// 读到的页住在 replica 里(@@@replica,owner 2026-11-14 open-flicker),❌ 组件 state:每次进页都从空开始、各台到一台
// 画一台,第二台一到整页重排、行上多出机器名(owner 2026-11-24「每次点进去都跳」)。再进页首帧就是上次那份完整的,
// 后台读回来原地替换。
// 本机索引按轮补:一轮 = 一次读(第 0 轮 400ms 预算,之后每轮 1200ms),本机 pending 没归零就隔 300ms 再读一轮。

const PAGE_LIMIT = 200;
const FIRST_ROUND_BUDGET_MS = 400;
const BACKGROUND_ROUND_BUDGET_MS = 1200;
const ROUND_PAUSE_MS = 300;
/** 轮数上限:正在被写入的 transcript 每轮都 miss 缓存,pending 可以永远不归零。到顶后停,下次进页再从第 0 轮起。 */
const MAX_ROUNDS = 40;

export type SessionHistoryState<TPage> = {
  page: TPage | null;
  /** 一条都还没拿到(首帧骨架用)。 */
  isLoading: boolean;
  /** 本机索引还在补:未导入那一档的结果还会变多。 */
  isIndexing: boolean;
  /** 换了筛选、这一套的页还没到:`page` 是上一套筛选的。 */
  isPrevious: boolean;
  error: string | null;
  /** 原始错误:别的机器问不通 / 太旧时,调用方按它说人话(describeImportFailure)。 */
  cause: unknown;
};

export type SessionHistoryDirectoryQuery = Omit<SessionHistoryDirectoryParams, 'mode' | 'hydrateBudgetMs'>;

type Round = { page: SessionHistoryDirectoryPage; round: number };

const indexing = (value: Round | undefined) => !!value && (value.page.local?.pending ?? 0) > 0 && value.round < MAX_ROUNDS;

/** 一台机器在一套筛选下的目录页。`query` 是 serialize 过的筛选(按值成键)。 */
const directoryPages = replica({
  name: 'sessionHistoryDirectories',
  scope: 'account',
  // 读的是本机主进程 / 名下那台机器:读不到就报,❌ 等浏览器说在线。
  networkMode: 'always',
  read: async (_owner, machine: string, query: string): Promise<Round> => {
    const shown = directoryPages.peek(machine, query);
    const previous = shown.state === 'value' ? shown.value : undefined;
    const round = indexing(previous) ? previous!.round + 1 : 0;
    const page = await rpcOn(machine === LOCAL_IMPORT_DEVICE ? null : machine).sessionHistory.listDirectories({
      ...(JSON.parse(query) as SessionHistoryDirectoryQuery),
      mode: 'fresh',
      hydrateBudgetMs: round === 0 ? FIRST_ROUND_BUDGET_MS : BACKGROUND_ROUND_BUDGET_MS,
    });
    return { page, round };
  },
  refreshEvery: (value) => (indexing(value) ? ROUND_PAUSE_MS : false),
});

/** 去掉 undefined、补默认 limit,再按值序列化:调用方每次渲染都新建 query 对象,按引用比会让面板每一帧都重拉。 */
function serialize(query: object): string {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query) as Array<[string, unknown]>) {
    if (value === undefined) continue;
    if (key === 'query') {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) normalized.query = trimmed;
      continue;
    }
    // 第一页不传 offset(与「没有分页」同一个请求形状,主进程测试钉的就是这个形状)。
    if (key === 'offset' && !value) continue;
    normalized[key] = value;
  }
  normalized.limit ??= PAGE_LIMIT;
  return JSON.stringify(normalized);
}

function stateOf(reading: Reading<Round>): SessionHistoryState<SessionHistoryDirectoryPage> {
  if (reading.state === 'unknown') return { page: null, isLoading: true, isIndexing: false, isPrevious: false, error: null, cause: null };
  if (reading.state === 'error') return { page: null, isLoading: false, isIndexing: false, isPrevious: false, error: reading.error.message, cause: reading.error };
  return {
    page: reading.value.page,
    isLoading: false,
    isIndexing: indexing(reading.value),
    isPrevious: reading.previous === true,
    error: reading.error?.message ?? null,
    cause: reading.error,
  };
}

export type MachineHistory = Readonly<Record<string, SessionHistoryState<SessionHistoryDirectoryPage>>>;

/**
 * 目录视图,全部问得到的机器一起读(每台各自分轮、各自出错);键是机器 id(本机 = LOCAL_IMPORT_DEVICE)。
 * 换筛选时各台留着上一页直到新的一页到(❌ 闪空);不再问的那台不在结果里。
 */
export function useSessionHistoryDirectories(query: SessionHistoryDirectoryQuery, machines: readonly string[]) {
  const key = serialize(query);
  const readings = useReplicas(directoryPages, machines.map((machine) => [machine, key] as [string, string]));
  // 这套筛选在这台上还没读过:先留着这台上一次画的那页(isPrevious),❌ 闪空。
  const shown = useRef<MachineHistory>({});
  const byMachine: MachineHistory = Object.fromEntries(
    machines.map((machine, index) => {
      const state = stateOf(readings[index]);
      const last = shown.current[machine];
      return [machine, state.isLoading && last?.page ? { ...last, isPrevious: true } : state];
    })
  );
  shown.current = byMachine;
  return { byMachine, refresh: refreshSessionHistory };
}

/** 全部机器、全部筛选的页都标旧,正在显示的那几份当场重读(归档 / 恢复 / 导入之后)。 */
function refreshSessionHistory(): void {
  void directoryPages.refresh();
}
