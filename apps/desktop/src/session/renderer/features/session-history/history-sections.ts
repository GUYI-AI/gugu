import type { AccountProject } from '@gugu/core/cloud/deviceProjects';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { rowOpens } from '@/session/shared/remote-sessions/session-directory';
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source';
import {
  compareSessionHistoryRows,
  compareSessionHistorySections,
  projectSectionKey,
  type SessionHistoryDirectoryRow,
  type SessionHistoryRow,
  type SessionHistorySort,
} from '@shared/core/session-history/session-history';

// 任务历史跨机器合并(项目与机器解耦 §5):项目是账号级的,机器只是每一行的属性。
// 每台问得到的机器各自给一份排好序的目录页(主进程已按账号项目归节 —— 节 key `project:<群>` —— 排好、截好);
// 离线的机器只有心跳摘要里那 ≤50 条。这里用主进程同一个比较函数(@shared)把各台的有序列表归并(❌ 重排:单台时
// 顺序与主进程给的逐条相同),再按节 key 聚到一起 —— 同一个项目在几台机器上的节落进同一节。

/** 一行 + 它在哪台机器上。离线机器的行来自心跳摘要:`opens` 照侧栏 / 手机同一条 rowOpens。 */
export type HistoryEntry = SessionHistoryRow & { machine: string; offline: boolean; opens: boolean };

/** 一节是谁:key 稳定;machine 非空 = 这一节是某台机器上的一个目录(没对上任何项目),节头要标机器。 */
export type SectionRef = { key: string; label: string; path: string | null; machine: string | null };

export type HistorySection = SectionRef & {
  /** 在线那几台在这一节里一共几条(主进程数的,可能多于 preview)。 */
  onlineCount: number;
  providers: string[];
  /** 在线那几台上归进这一节的目录:「显示更多」按它们逐台要。 */
  members: Array<{ machine: string; directory: string | null }>;
  /** 在线那几台随目录页带回的头几条,已归并。 */
  preview: HistoryEntry[];
  /** 离线机器在这一节里的行(心跳摘要),已排好。 */
  offline: HistoryEntry[];
  offlineMachines: string[];
};

/** 一个账号项目的那一节:键 = 项目群,名字 = 项目名(各台机器上的本地项目都归这一节)。 */
export function historyProjectSection(project: Pick<AccountProject, 'chatId' | 'name'>): SectionRef {
  return { key: projectSectionKey(project.chatId), label: project.name, path: null, machine: null };
}

/** 一行归哪一节、节按什么排:目录页上的那三样(主进程给);离线的摘要行由调用方按同一口径给。 */
export type SectionKeyed = Pick<SessionHistoryDirectoryRow, 'key' | 'directory' | 'projectName'>;

/** 把几份各自有序的列表归并成一份;每份内部的先后不变。 */
export function mergeSorted<T>(lists: ReadonlyArray<readonly T[]>, compare: (a: T, b: T) => number): T[] {
  const heads = lists.map(() => 0);
  const out: T[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < lists.length; i += 1) {
      if (heads[i] >= lists[i].length) continue;
      if (best < 0 || compare(lists[i][heads[i]], lists[best][heads[best]]) < 0) best = i;
    }
    if (best < 0) return out;
    out.push(lists[best][heads[best]]);
    heads[best] += 1;
  }
}

/** 在线机器读来的一行。别的机器的行 key 带上机器:本机行按文件路径认,两台上可以撞。 */
export function entryOf(machine: string, row: SessionHistoryRow): HistoryEntry {
  return { ...row, key: machine === LOCAL_IMPORT_DEVICE ? row.key : `${machine}/${row.key}`, machine, offline: false, opens: true };
}

/** 离线机器心跳摘要里的一条:咕咕自己的活跃会话(摘要里没有归档的、也没有原件)。 */
export function digestEntry(machine: string, session: SessionpageSessionSummary): HistoryEntry {
  const at = session.lastInteractedAt ? Date.parse(session.lastInteractedAt) : NaN;
  const updatedAt = Number.isFinite(at) ? at : 0;
  return {
    key: `${machine}/gugu:${session.conversationId}`,
    source: 'gugu',
    status: 'active',
    title: session.title,
    providerSessionId: null,
    providerId: session.harness,
    directory: session.cwd ?? null,
    projectName: null,
    updatedAt,
    lastPromptAt: Number.isFinite(at) ? at : null,
    addedAt: null,
    archivedAt: null,
    childCount: 0,
    parentTitle: null,
    gugu: { projectId: session.projectId, sessionId: session.conversationId, runtime: session.runtime === 'pty' ? 'pty' : 'acp' },
    machine,
    offline: true,
    opens: rowOpens(session),
  };
}

type Item = Pick<SessionHistoryDirectoryRow, 'updatedAt' | 'lastPromptAt' | 'addedAt' | 'directory' | 'projectName'> & {
  ref: SectionRef;
  online?: { machine: string; row: SessionHistoryDirectoryRow };
  offline?: HistoryEntry;
};

/**
 * 各台的目录页 + 离线行 → 一节一个项目。节的先后 = 归并后它第一次出现的位置;节内的行按同一排序归并。
 * 在线的每一行就是主进程给的一节,离线的每一行由 `keyOfEntry` 按同一口径给出它那一节;两种都经 `sectionOf`
 * (机器 + 节 key → 节)落到同一个节上。在线一行是一节、离线一行是一条,排序时都按「它那一节」比
 * (`compareSessionHistorySections`,主进程排目录页用的就是它)—— 各路同一把尺子、各自有序,归并才成立。
 */
export function buildSections({
  sort,
  pages,
  offline,
  keyOfEntry,
  sectionOf,
}: {
  sort: SessionHistorySort;
  pages: ReadonlyArray<{ machine: string; rows: readonly SessionHistoryDirectoryRow[] }>;
  offline: readonly HistoryEntry[];
  keyOfEntry: (entry: HistoryEntry) => SectionKeyed;
  sectionOf: (machine: string, keyed: SectionKeyed) => SectionRef;
}): HistorySection[] {
  const compareRows = compareSessionHistoryRows(sort);
  const compareItems = compareSessionHistorySections(sort);
  const onlineItems = pages.map(({ machine, rows }) =>
    rows.map((row): Item => ({ ...itemOf(row), ref: sectionOf(machine, row), online: { machine, row } })));
  const offlineItems = offline
    .map((entry): Item => {
      const keyed = keyOfEntry(entry);
      return { ...itemOf({ ...entry, ...keyed }), ref: sectionOf(entry.machine, keyed), offline: entry };
    })
    .sort(compareItems);
  const lists = [...onlineItems, offlineItems].filter((list) => list.length > 0);

  const sections = new Map<string, HistorySection & { previews: HistoryEntry[][] }>();
  for (const item of mergeSorted(lists, compareItems)) {
    let section = sections.get(item.ref.key);
    if (!section) {
      section = { ...item.ref, onlineCount: 0, providers: [], members: [], preview: [], offline: [], offlineMachines: [], previews: [] };
      sections.set(item.ref.key, section);
    }
    const providers = item.online ? item.online.row.providers : item.offline?.providerId ? [item.offline.providerId] : [];
    for (const provider of providers) if (!section.providers.includes(provider)) section.providers.push(provider);
    if (item.online) {
      const { machine, row } = item.online;
      section.onlineCount += row.sessionCount;
      section.members.push({ machine, directory: row.directory });
      section.previews.push(row.sessions.map((session) => entryOf(machine, session)));
    } else if (item.offline) {
      section.offline.push(item.offline);
      if (!section.offlineMachines.includes(item.offline.machine)) section.offlineMachines.push(item.offline.machine);
    }
  }
  return [...sections.values()].map(({ previews, ...section }) => ({ ...section, preview: mergeSorted(previews, compareRows) }));
}

function itemOf(row: Omit<Item, 'ref' | 'online' | 'offline'>): Omit<Item, 'ref' | 'online' | 'offline'> {
  return { updatedAt: row.updatedAt, lastPromptAt: row.lastPromptAt, addedAt: row.addedAt, directory: row.directory, projectName: row.projectName };
}
