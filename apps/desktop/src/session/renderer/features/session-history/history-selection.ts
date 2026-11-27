import type { HistoryEntry } from './history-sections';

/**
 * 会话历史的批量操作:先定「选中的是什么」(范围),再定「对它做什么」(行为)—— owner 2026-11-27 00:59,
 * 设计稿第 2 稿「范围 × 行为」表(owner 01:16 认可)。这里只有判据,不画任何东西,也不发任何请求。
 *
 * 范围:单条 / 勾选几条(Shift 一段、⌘A 这一屏展开的)/ 整个项目(节头勾选框,含没展开的)/ 时间段(筛选栏「时间」)/
 * 当前筛选出的全部(底部条「选中筛选出的全部 N 条」)。几种范围叠在一起就是一个行的集合 —— 选中的永远是具体的行,
 * 节头与「全部」只是一次多加几条。
 *
 * 行为按选中行的状态给,两边都做得了的操作一个也没有(归档 / 移到项目只对活跃,恢复 / 永久删除只对已归档):
 * 混着选时什么都不给,只给两个收窄按钮。要加一个行为(移到项目),在 `BULK_ACTIONS` 里加一项、在调用方加一个处理。
 */

export type BulkStatus = 'active' | 'archived';

/** 选中的一行:动作需要的全在这里(它在哪台机器、哪一节、是哪条会话),不必回头找列表里的那一行。 */
export type SelectedSession = {
  key: string;
  /** 行所在的机器(本机 = LOCAL_IMPORT_DEVICE)。 */
  machine: string;
  status: BulkStatus;
  sectionKey: string;
  title: string;
  projectId: string;
  sessionId: string;
  updatedAt: number;
};

export type HistorySelection = {
  rows: ReadonlyMap<string, SelectedSession>;
  /** Shift 区间的起点:上一次单独勾 / 取消的那一行。 */
  anchor: string | null;
  /** 刚点过「选中筛选出的全部」:标签写「已选筛选出的全部 N 条」。再勾掉任何一条就不是了。 */
  across: boolean;
};

export const EMPTY_SELECTION: HistorySelection = { rows: new Map(), anchor: null, across: false };

/**
 * 能勾的行:咕咕自己的、活跃或已归档的、在问得到的机器上的。未导入的原件要先导入;离线机器上的行(心跳摘要)
 * 此刻够不着那台机器,勾上了也做不了任何事。
 */
export function selectableEntry(entry: HistoryEntry): boolean {
  return !!entry.gugu && !entry.offline && (entry.status === 'active' || entry.status === 'archived');
}

export function toSelected(entry: HistoryEntry, sectionKey: string): SelectedSession | null {
  if (!selectableEntry(entry) || !entry.gugu) return null;
  return {
    key: entry.key,
    machine: entry.machine,
    status: entry.status as BulkStatus,
    sectionKey,
    title: entry.title,
    projectId: entry.gugu.projectId,
    sessionId: entry.gugu.sessionId,
    updatedAt: entry.updatedAt,
  };
}

/**
 * 勾 / 取消一行。Shift 且起点还在眼前:从起点到这一行整段改成起点现在的状态(Finder / Gmail 的手势);
 * 否则只改这一行并把它记成新的起点。`visible` = 眼前展开着、能勾的行,按画出来的先后。
 */
export function toggleRow(
  selection: HistorySelection,
  row: SelectedSession,
  visible: readonly SelectedSession[],
  shift: boolean
): HistorySelection {
  const rows = new Map(selection.rows);
  const from = selection.anchor === null ? -1 : visible.findIndex((candidate) => candidate.key === selection.anchor);
  const to = visible.findIndex((candidate) => candidate.key === row.key);
  if (shift && from >= 0 && to >= 0) {
    const want = rows.has(selection.anchor!);
    for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) {
      if (want) rows.set(visible[index].key, visible[index]);
      else rows.delete(visible[index].key);
    }
    return { rows, anchor: selection.anchor, across: false };
  }
  if (rows.has(row.key)) rows.delete(row.key);
  else rows.set(row.key, row);
  return { rows, anchor: row.key, across: false };
}

export function addRows(selection: HistorySelection, add: Iterable<SelectedSession>, across = false): HistorySelection {
  const rows = new Map(selection.rows);
  for (const row of add) rows.set(row.key, row);
  return { rows, anchor: selection.anchor, across };
}

export function removeRows(selection: HistorySelection, keys: Iterable<string>): HistorySelection {
  const rows = new Map(selection.rows);
  for (const key of keys) rows.delete(key);
  return { rows, anchor: selection.anchor && rows.has(selection.anchor) ? selection.anchor : null, across: false };
}

/** 混着选时的收窄:「只留活跃的 a 条」/「只留已归档的 z 条」。 */
export function keepOnly(selection: HistorySelection, status: BulkStatus): HistorySelection {
  const rows = new Map([...selection.rows].filter(([, row]) => row.status === status));
  return { rows, anchor: selection.anchor && rows.has(selection.anchor) ? selection.anchor : null, across: false };
}

export type SelectionCounts = { active: number; archived: number; total: number };

export function countSelection(selection: HistorySelection): SelectionCounts {
  let active = 0;
  let archived = 0;
  for (const row of selection.rows.values()) {
    if (row.status === 'active') active += 1;
    else archived += 1;
  }
  return { active, archived, total: active + archived };
}

export function selectedInSection(selection: HistorySelection, sectionKey: string): number {
  let count = 0;
  for (const row of selection.rows.values()) if (row.sectionKey === sectionKey) count += 1;
  return count;
}

export type CheckState = 'off' | 'on' | 'mixed';

/** 节头勾选框:一条没选 = 空;这一节当前筛选下能勾的全选上 = 勾;选了一部分 = 横杠(再点一下 = 整节全选)。 */
export function sectionCheck(selected: number, selectable: number): CheckState {
  if (selected <= 0) return 'off';
  return selected >= selectable ? 'on' : 'mixed';
}

export type BulkActionId = 'archive' | 'restore' | 'delete';

/** 每种状态能做的批量动作,按底部条上的先后。混着选 = 两个列表的交集 = 空。 */
export const BULK_ACTIONS: Readonly<Record<BulkStatus, readonly BulkActionId[]>> = {
  active: ['archive'],
  archived: ['restore', 'delete'],
};

export type BulkMode =
  | { kind: 'none' }
  | { kind: 'single'; status: BulkStatus; actions: readonly BulkActionId[] }
  | { kind: 'mixed'; active: number; archived: number };

export function bulkModeOf(counts: SelectionCounts): BulkMode {
  if (counts.total === 0) return { kind: 'none' };
  if (counts.active > 0 && counts.archived > 0) return { kind: 'mixed', active: counts.active, archived: counts.archived };
  const status: BulkStatus = counts.active > 0 ? 'active' : 'archived';
  return { kind: 'single', status, actions: BULK_ACTIONS[status] };
}

/** 选中的行里,某个动作作用得上的那几条(动作只出现在全是同一状态时,这里再按状态收一遍,❌ 信任调用方)。 */
export function targetsOf(selection: HistorySelection, action: BulkActionId): SelectedSession[] {
  const status: BulkStatus = action === 'archive' ? 'active' : 'archived';
  return [...selection.rows.values()].filter((row) => row.status === status);
}

/**
 * 底部条的标签与「选中筛选出的全部 N 条」那个链接。`total` = 当前筛选下能勾的一共几条(还没数出来是 null)。
 * 已经全选上了就不再给链接;刚点过「全部」的标签写「已选筛选出的全部 N 条」。
 */
export function selectionLabel(selection: HistorySelection, total: number | null): {
  count: number;
  allSelected: boolean;
  acrossLabel: boolean;
  offerAll: number | null;
} {
  const count = selection.rows.size;
  const allSelected = total !== null && count >= total;
  return {
    count,
    allSelected,
    acrossLabel: allSelected && selection.across,
    offerAll: !allSelected && total !== null && total > count ? total : null,
  };
}

/**
 * 归档确认框的标题说的是哪一种范围(第 2 稿范围 × 行为表):整个项目(筛到「活跃」时写项目名,叠了时间就带上时间)、
 * 按时间选中的全部(写时间)、其余只写条数。永久删除的框只写条数(owner 01:03),不用它。
 */
export type ArchiveScope =
  | { kind: 'one' }
  | { kind: 'section'; section: string; time: string | null; count: number }
  | { kind: 'time'; time: string; count: number }
  | { kind: 'count'; count: number };

export function archiveScopeOf(args: {
  rows: readonly SelectedSession[];
  /** 这一节在当前筛选下能勾的活跃会话一共几条。 */
  sectionActive: (sectionKey: string) => number;
  sectionLabel: (sectionKey: string) => string;
  /** 筛选栏「时间」生效时的说法(「一个月前」),没筛时间为 null。 */
  timeLabel: string | null;
  /** 刚点过「选中筛选出的全部」、且就是全部的活跃会话。 */
  across: boolean;
}): ArchiveScope {
  const { rows, sectionActive, sectionLabel, timeLabel, across } = args;
  if (rows.length === 1) return { kind: 'one' };
  const sections = [...new Set(rows.map((row) => row.sectionKey))];
  if (sections.length === 1 && rows.length === sectionActive(sections[0])) {
    return { kind: 'section', section: sectionLabel(sections[0]), time: timeLabel, count: rows.length };
  }
  if (across && timeLabel) return { kind: 'time', time: timeLabel, count: rows.length };
  return { kind: 'count', count: rows.length };
}

/** 筛选栏「时间」:最后更新在那之前(一周前 / 一个月前 / 三个月前 / 自定义日期)。 */
export type HistoryTimeFilter = { kind: 'any' } | { kind: 'days'; days: 7 | 30 | 90 } | { kind: 'date'; date: string };

export const TIME_PRESETS = [7, 30, 90] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 截止时刻(epoch ms):最后更新早于它的才留下。自定义日期 = 那天本地零点(「那天之前」不含那天)。 */
export function timeCutoff(filter: HistoryTimeFilter, now: number): number | undefined {
  if (filter.kind === 'any') return undefined;
  if (filter.kind === 'days') return now - filter.days * DAY_MS;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(filter.date);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/** `now` 按分钟取整:同一套筛选在一分钟内是同一个请求(replica 按值成键),❌ 每次渲染一个新键。 */
export function cutoffClock(now: number): number {
  return Math.floor(now / 60_000) * 60_000;
}
