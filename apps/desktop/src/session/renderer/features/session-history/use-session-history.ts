import { useCallback, useEffect, useState } from 'react';
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source';
import { rpcOn } from '@renderer/lib/ipc';
import type {
  SessionHistoryDirectoryPage,
  SessionHistoryDirectoryParams,
  SessionHistoryPage,
  SessionHistoryParams,
} from '@shared/core/session-history/session-history';

// spec session-page「会话历史」(#6083):面板的数据源。按轮读:
//   第 0 轮 本机索引缓存直接出(毫秒级,面板一开就有东西看;咕咕自己的会话每轮都是库里的真值)
//   第 1 轮 对账磁盘 + 解析一小批(400ms 预算)
//   第 n 轮 继续解析,直到本机索引 pending 归零
// 每轮结果整页替换 —— 筛 / 排 / 聚合都在主进程做完了,这里**不排序、不分组**,只按给定顺序画。
// 每台问得到的机器各读各的(那台机器上同一个 `sessionHistory` 控制器,读的是它的库与各家原件),由面板合并。

const PAGE_LIMIT = 200;
const FIRST_ROUND_BUDGET_MS = 400;
const BACKGROUND_ROUND_BUDGET_MS = 1200;
const ROUND_PAUSE_MS = 300;
/** 轮数上限:正在被写入的 transcript 每轮都 miss 缓存,pending 可以永远不归零。 */
const MAX_ROUNDS = 40;

type LocalProgress = SessionHistoryPage['local'];
type RoundParams = Pick<SessionHistoryParams, 'mode' | 'hydrateBudgetMs'>;

export type SessionHistoryState<TPage> = {
  page: TPage | null;
  /** 一条都还没拿到(首帧骨架用)。 */
  isLoading: boolean;
  /** 本机索引还在补:未导入那一档的结果还会变多。 */
  isIndexing: boolean;
  error: string | null;
  /** 原始错误:别的机器问不通 / 太旧时,调用方按它说人话(describeImportFailure)。 */
  cause: unknown;
};

export type SessionHistoryDirectoryQuery = Omit<SessionHistoryDirectoryParams, 'mode' | 'hydrateBudgetMs'>;

const IDLE = { page: null, isLoading: false, isIndexing: false, error: null, cause: null };

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

/** 一台机器按轮读到第几轮了;读完 / 读错停下。`put` 只写这一台那一格,❌ 动别的机器。 */
async function runRounds<TParams extends object, TPage extends { local: LocalProgress }>(
  fetchPage: (params: TParams & RoundParams) => Promise<TPage>,
  base: TParams,
  cancelled: () => boolean,
  put: (next: (prev: SessionHistoryState<TPage>) => SessionHistoryState<TPage>) => void
): Promise<void> {
  try {
    const cached = await fetchPage({ ...base, mode: 'cached' });
    if (cancelled()) return;
    // 缓存页只在本机索引真有缓存时才值得画;没有时下一轮 fresh 马上到。
    if (cached.local?.stale) put(() => ({ page: cached, isLoading: false, isIndexing: false, error: null, cause: null }));

    let budgetMs = FIRST_ROUND_BUDGET_MS;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const fresh = await fetchPage({ ...base, mode: 'fresh', hydrateBudgetMs: budgetMs });
      if (cancelled()) return;
      const pending = fresh.local?.pending ?? 0;
      put(() => ({ page: fresh, isLoading: false, isIndexing: pending > 0, error: null, cause: null }));
      if (pending === 0) return;
      budgetMs = BACKGROUND_ROUND_BUDGET_MS;
      await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS));
      if (cancelled()) return;
    }
  } catch (error) {
    if (cancelled()) return;
    put((prev) => ({
      ...prev,
      isLoading: false,
      isIndexing: false,
      error: error instanceof Error ? error.message : String(error),
      cause: error,
    }));
  }
}

export type MachineHistory = Readonly<Record<string, SessionHistoryState<SessionHistoryDirectoryPage>>>;

/**
 * 目录视图,全部问得到的机器一起读(每台各自分轮、各自出错);键是机器 id(本机 = LOCAL_IMPORT_DEVICE)。
 * 换筛选时各台留着上一页直到新的一页到(❌ 闪空);不再问的那台连同它的页一起丢掉。
 */
export function useSessionHistoryDirectories(query: SessionHistoryDirectoryQuery, machines: readonly string[]) {
  const [attempt, setAttempt] = useState(0);
  const [byMachine, setByMachine] = useState<MachineHistory>({});
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  const key = serialize(query);
  const machinesKey = machines.join('\n');

  useEffect(() => {
    const ids = machinesKey ? machinesKey.split('\n') : [];
    setByMachine((prev) =>
      Object.fromEntries(
        ids.map((id) => {
          const old = prev[id];
          return [id, old ? { ...old, isLoading: old.page === null, error: null, cause: null } : { ...IDLE, isLoading: true }];
        })
      )
    );
    let cancelled = false;
    const base = JSON.parse(key) as SessionHistoryDirectoryQuery;
    for (const id of ids) {
      const rpc = rpcOn(id === LOCAL_IMPORT_DEVICE ? null : id);
      void runRounds<SessionHistoryDirectoryQuery, SessionHistoryDirectoryPage>(
        (params) => rpc.sessionHistory.listDirectories(params),
        base,
        () => cancelled,
        (next) => setByMachine((prev) => (prev[id] ? { ...prev, [id]: next(prev[id]) } : prev))
      );
    }
    return () => {
      cancelled = true;
    };
  }, [key, machinesKey, attempt]);

  return { byMachine, refresh };
}
