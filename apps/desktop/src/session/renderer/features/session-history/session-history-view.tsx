import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { messageForUser } from '@/lib/userFacingError';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Folder, ListFilter, Monitor } from '@/lib/icons';
import type { ViewDefinition } from '@renderer/app/view-registry';
import { restoreArchivedSession } from '@renderer/features/sessions/restore-session-flow';
import { isImplicitSessionHomeProject, isWorkspaceProject } from '@renderer/features/sessions/session-home-project-constants';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useWakeCloudOnce } from '@renderer/features/remote-hosts/use-wake-cloud-once';
import {
  describeImportFailure,
  importDeviceChoices,
  importDeviceState,
} from '@renderer/features/session-import/import-device';
import { countOutcomes, runImport, type ImportOutcome } from '@renderer/features/session-import/import-runner';
import { LOCAL_IMPORT_DEVICE, resolveImportSource, type SessionImportSource } from '@renderer/features/session-import/import-source';
import { ImportSummary } from '@renderer/features/session-import/import-summary';
import { shortenPath } from '@renderer/features/session-import/session-row';
import { AgentIcon } from '@renderer/lib/components/agent-icon';
import { PageContent, PageLayout } from '@renderer/lib/components/page-layout';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { toast } from '@renderer/lib/hooks/use-toast';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { openLink } from '@/lib/guguLinks';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Spinner } from '@renderer/lib/ui/spinner';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import {
  SESSION_HISTORY_SOURCES,
  SESSION_HISTORY_STATUSES,
  SESSION_HOME_SECTION_KEY,
  compareSessionHistoryRows,
  matchesSessionHistoryFilters,
  projectSectionChatId,
  projectSectionKey,
  type SessionHistoryGuguRef,
  type SessionHistorySort,
} from '@shared/core/session-history/session-history';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import {
  buildSections,
  digestEntry,
  entryOf,
  historyProjectSection,
  mergeSorted,
  type HistoryEntry,
  type HistorySection,
  type SectionKeyed,
  type SectionRef,
} from './history-sections';
import { STATUS_MESSAGE_KEY, SessionHistoryRow, historyOptionId, sourceLabel } from './session-history-row';
import { SessionHistorySectionBox } from './session-history-section-box';
import type { SessionHistorySourceFilter, SessionHistoryStatusFilter, SessionHistoryViewParams } from './session-history-import-part';
import { useSessionHistoryDirectories } from './use-session-history';
import { LegacyDmArchiveButton } from '@/components/legacy-dm-history/LegacyDmHistoryEntry';

// spec session-page「会话历史」(#6083)。形状照 设计同事 2026-09-23 给的参照(「直接 copy 这套会话历史」):
//   标题行(右侧一个动作)→ 搜索 + 一个分组筛选菜单 + 机器筛选 → 一项目一节(节头:文件夹图标、名字、
//   这一节里出现过的 agent 图标、条数)→ 节内两行一条(标题 / 时间 · 机器,右侧一个动作)。
// 每节默认只露头 5 条、平铺、没有滚动条;随目录页也只带回这 5 条(主人 2026-09-25:「默认没有滑动条,点『显示更多』
// 之后才显示滑动条,否则前端压力太大;也不应该全部加载到内存里,应该是懒加载」)。点「显示更多」这一节才变成限高小窗,
// 当场按这一节要下一批,在窗里滚到底再要下一批;「收起」回到 5 条并把多要来的那些行扔掉。
// 列表滚到底自动多要一批目录(❌ 翻页)。筛、排、聚合、截断都是各台主进程做完的(list-session-history);
// 这里只把各台排好的列表按同一个排序键归并(history-sections.ts),❌ 自己重排。
//
// 默认只看咕咕自己的会话(活跃 + 已归档):本机引擎磁盘上没导入的有几千条,默认混进来就把页面淹了
// (主人 2026-09-23 11:52 拍板);它们在筛选菜单「来源」里按引擎各一档。
//
// 行动作按状态分:活跃 → 打开;已归档 → 恢复回列表;未导入 → 导入(沿用导入管道:绑 provider 的
// session id、resume 原会话,❌ 搬副本)。
//
// 项目与机器解耦(§5):一页列全部机器,一个账号项目一节(同一项目在几台机器上的任务进同一节),机器只是行上的标记
// 和一个可选筛选。问得到的机器并行读;离线的用心跳摘要顶上(≤50 条),行标离线,节尾写哪台离线。
// 行动作都作用在**这一行所在的机器**上 —— 会话归原件所在的机器,❌ 原件跨机器搬。

type SourceFilter = SessionHistorySourceFilter;
type StatusFilter = SessionHistoryStatusFilter;

/** 滚到底一次多要这么多目录(每台机器)。 */
const BATCH_SIZE = 50;
/**
 * 每节默认露出几条 —— 随目录页也只带回这么多。❌ 一次把每节上百条都拉进渲染进程、都画出来:
 * 50 节 × 100 条就是 5000 行,本机原件一多面板就卡(主人 2026-09-25)。
 */
const SECTION_PREVIEW = 5;
/** 点开之后,小窗里每次多要这么多(当场一批,滚到窗底再一批)。 */
const SECTION_BATCH = 50;
/** 节头最多画几个 agent 图标:再多就成了一排噪音。 */
const SECTION_AGENT_ICONS = 3;
/** 搜索词像一个 session id 前缀时(不含空格、够长)才按「id 命中」高亮那一条;短词只是普通关键词。 */
const SESSION_ID_QUERY_MIN = 6;
const DEFAULT_SOURCE: SourceFilter = 'gugu';

const SORT_KEY: Record<SessionHistorySort, SessionMessageKey> = {
  updated: 'sessionHistory.sortUpdated',
  lastPrompt: 'sessionHistory.sortLastPrompt',
  title: 'sessionHistory.sortTitle',
  added: 'sessionHistory.sortAdded',
};
/** 排序档照模板「排序方式」三档的顺序:更新时间 / 创建时间 / 按字母顺序。 */
const SORT_OPTIONS: readonly SessionHistorySort[] = ['updated', 'added', 'title'];

/** 在小窗里滚出来的那几批(在线那几台的):按节 key 存,换筛选即清。`matched` 是那几台给的这一节总数。 */
type SectionPage = { rows: HistoryEntry[]; matched: number };

/** rpcOn / onMachineEvent / openLink / accountProjectsStore 里本机写 null。 */
function machineArg(machine: string): string | null {
  return machine === LOCAL_IMPORT_DEVICE ? null : machine;
}

function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** 搜索词是不是某条会话的 session id(或 conversation id)的前缀:是就把那条当作「搜到的就是它」。 */
function matchesSessionId(row: HistoryEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length < SESSION_ID_QUERY_MIN || /\s/.test(q)) return false;
  return [row.providerSessionId, row.gugu?.sessionId].some((id) => !!id && id.toLowerCase().startsWith(q));
}

// observer:名下机器上线 / 离线 / 改名、项目行变了时列表跟着变。
export const SessionHistoryMainPanel = observer(function SessionHistoryMainPanel() {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const choices = importDeviceChoices(
    translate('task.deviceLocal'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => device),
    (id) => remoteHostsStore.connectionState(id) === 'reconnecting'
  );
  const labelOf = (machine: string) => choices.find((choice) => choice.id === machine)?.label ?? machine;
  /** 机器筛选:null = 全部机器。选的那台不在名下了 = 回到全部。 */
  const [pickedMachine, setPickedMachine] = useState<string | null>(null);
  const filterChoice = choices.find((choice) => choice.id === pickedMachine) ?? null;
  const machineFilter = filterChoice?.id ?? null;
  // #7199 筛到一台睡着的云电脑 = 要看它上面的会话:叫醒它(每次选中一次),醒了它的行自己出来。
  useWakeCloudOnce(machineFilter, filterChoice ? (filterChoice.cloudComputer === 'asleep' ? 'asleep' : 'other') : null);
  const inView = filterChoice ? [filterChoice] : choices;
  // 问得到的才去问(离线、没醒的只会挂满超时);问不到的读心跳摘要。
  const reachable = inView.filter((choice) => importDeviceState(choice.id, choices).blocked === null).map((choice) => choice.id);
  const unreachable = inView.filter((choice) => !reachable.includes(choice.id)).map((choice) => choice.id);
  const describe = (error: unknown, kind: 'list' | 'preview' | 'import', machine: string) =>
    describeImportFailure(error, { isLocal: machine === LOCAL_IMPORT_DEVICE }, labelOf(machine), kind, translate);
  // 进来时可以带一部分(#2548 侧栏「导入以前的会话」带的是导入那一部分,SESSION_HISTORY_IMPORT_PART):首帧就停在那里;
  // 页面开着时又带着进来一次,就再落回那一部分。参数是转瞬的,之后的筛选照旧由人自己改。
  const { params: entry } = useParams('session-history');
  const entryPart = entry.source !== undefined || entry.status !== undefined ? entry : null;
  const [source, setSource] = useState<SourceFilter>(entryPart?.source ?? DEFAULT_SOURCE);
  const [status, setStatus] = useState<StatusFilter>(entryPart?.status ?? 'all');
  useEffect(() => {
    if (!entryPart) return;
    setSource(entryPart.source ?? DEFAULT_SOURCE);
    setStatus(entryPart.status ?? 'all');
  }, [entryPart]);
  const [sort, setSort] = useState<SessionHistorySort>('updated');
  const [rawQuery, setRawQuery] = useState('');
  const query = useDebounce(rawQuery, 200);
  const [limit, setLimit] = useState(BATCH_SIZE);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [sectionPages, setSectionPages] = useState<Readonly<Record<string, SectionPage>>>({});
  /** 点过「显示更多」的节:只有它们是限高小窗、会懒加载;其余节只露头几条。 */
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set());
  const openSectionsRef = useRef(openSections);
  openSectionsRef.current = openSections;
  const [loadingSections, setLoadingSections] = useState<ReadonlySet<string>>(() => new Set());
  /** 换筛选 / 刷新就换一代:上一代还在路上的那批回来时直接丢掉,❌ 写进新筛选的节里。 */
  const sectionGeneration = useRef(0);
  const [isImporting, setIsImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => !!element && !!rootRef.current?.contains(element),
    getCommands: () => [{ id: 'app.find', hideFromPalette: true, execute: () => searchRef.current?.focus() }],
  });

  const moreRef = useRef<HTMLDivElement>(null);

  // 换任何筛选条件都从头要一批、收起详情。
  useEffect(() => {
    setLimit(BATCH_SIZE);
    setExpandedKey(null);
    sectionGeneration.current += 1;
    setSectionPages({});
    setOpenSections(new Set());
    setLoadingSections(new Set());
  }, [source, status, sort, query, machineFilter]);

  const filters = {
    source: source === 'all' ? undefined : source,
    status: status === 'all' ? undefined : status,
    query,
    sort,
  };
  // 滚动加载 = 同一个请求把 limit 放大(主进程排好序再截,前面那截与上一批逐条相同),❌ 渲染侧拼多页。
  const { byMachine, refresh } = useSessionHistoryDirectories(
    { ...filters, limit, sessionsPerDirectory: SECTION_PREVIEW },
    reachable
  );

  // 一节 = 主进程给的节 key:`project:<群>` 是账号上的一个项目(几台机器上的并成一节,名字照账号上的项目);
  // 任务那一节;别的按「机器 · 目录」各一节。
  // @@@old-host-sections - 旧版本的远端主机还按目录给节(没有 `project:` key):它的行照目录各一节、不并进项目那一节,
  // 升级后自然并上。这是跨版本的已知差别,不是兜底 —— 新主机的行都带着它的项目 key。
  const homeRef: SectionRef = { key: SESSION_HOME_SECTION_KEY, label: translate('sessionHistory.taskHomeSection'), path: null, machine: null };
  const sectionOf = (machine: string, keyed: SectionKeyed): SectionRef => {
    if (keyed.key === SESSION_HOME_SECTION_KEY) return homeRef;
    const chatId = projectSectionChatId(keyed.key);
    // 节名照账号上的项目(与侧栏同一个名字);账号项目表还没读到时用那台机器上的项目名。
    if (chatId) return historyProjectSection({ chatId, name: accountProjectsStore.project(chatId)?.name ?? keyed.projectName ?? '' });
    return {
      key: `dir:${machine}:${keyed.directory ?? ''}`,
      label: keyed.directory ? baseName(keyed.directory) : translate('sessionHistory.noDirectory'),
      path: keyed.directory,
      machine,
    };
  };
  // 离线机器的摘要行主进程看不到:按它自己的本地项目 → 账号项目,给出与主进程同一口径的节 key。
  const projects = getProjectManagerStore().projects;
  const keyOfEntry = (entry: HistoryEntry): SectionKeyed => {
    const projectId = entry.gugu?.projectId;
    const store = projectId ? projects.get(projectId) : undefined;
    if (projectId && (isImplicitSessionHomeProject({ id: projectId }) || (store && isWorkspaceProject(store)))) {
      return { key: SESSION_HOME_SECTION_KEY, directory: SESSION_HOME_SECTION_KEY, projectName: null };
    }
    const account = projectId ? accountProjectsStore.projectOfLocal(projectId, machineArg(entry.machine)) : undefined;
    if (account) {
      const key = projectSectionKey(account.chatId);
      return { key, directory: key, projectName: account.name };
    }
    return { key: entry.directory ?? '', directory: entry.directory, projectName: null };
  };
  const offlineEntries = unreachable
    .flatMap((machine) => remoteHostsStore.sessionsOf(machine).sessions.map((session) => digestEntry(machine, session)))
    .filter((entry) => matchesSessionHistoryFilters(entry, filters));
  const sections = buildSections({
    sort,
    pages: reachable.flatMap((machine) => {
      const page = byMachine[machine]?.page;
      return page ? [{ machine, rows: page.rows }] : [];
    }),
    offline: offlineEntries,
    keyOfEntry,
    sectionOf,
  });
  // 只有一台机器的行时不标机器(与侧栏「跟上面那一行比」同一个道理:全是一台就不用说)。
  const spansMachines =
    new Set(sections.flatMap((section) => [...section.members.map((member) => member.machine), ...section.offlineMachines])).size > 1;

  const compareRows = compareSessionHistoryRows(sort);
  const isSectionOpen = (section: HistorySection) => openSections.has(section.key);
  const sessionCount = (section: HistorySection) => section.onlineCount + section.offline.length;
  // 一节眼下有哪些行:点开了、并且已经要来过更多的,就用那一批(它的头一截与目录页带回的逐条相同 —— 同一个排序,
  // 主进程排好再截);没点开的只露头几条。离线那几台的行一直在(就那么些)。
  const sectionSessions = (section: HistorySection) =>
    isSectionOpen(section)
      ? mergeSorted([sectionPages[section.key]?.rows ?? section.preview, section.offline], compareRows)
      : mergeSorted([section.preview, section.offline], compareRows).slice(0, SECTION_PREVIEW);
  const sectionTruncated = (section: HistorySection) =>
    sessionCount(section) > Math.min(SECTION_PREVIEW, section.preview.length + section.offline.length);
  const sectionHasMore = (section: HistorySection) => {
    const page = sectionPages[section.key];
    return page ? page.rows.length < page.matched : section.preview.length < section.onlineCount;
  };
  // 眼前的会话行(所有节拼起来):键盘光标与 session id 命中都对着它们。
  const rows = sections.flatMap(sectionSessions);
  const states = reachable.map((machine) => byMachine[machine]);
  const isLoading = states.some((state) => !state || state.isLoading);
  const isIndexing = states.some((state) => state?.isIndexing);
  const loaded = Math.max(0, ...states.map((state) => state?.page?.rows.length ?? 0));
  const hasMore = states.some((state) => !!state?.page && state.page.rows.length < state.page.matched);
  const failed = reachable.filter((machine) => byMachine[machine]?.error);
  // 搜索词就是某条的 session id 前缀 → 那条就是用户要找的:光标落在它身上并上色。
  const idHit = query.trim() ? (rows.find((row) => matchesSessionId(row, query)) ?? null) : null;
  // activeKey 只记「用户点过哪条」,真正生效的光标在渲染时算:列表一变(换筛选、翻页、索引补进来一批),
  // 原来那条可能已经不在列表里,直接回落到第一条。❌ 用 effect 纠正 —— 那多一帧,而那一帧里动作指着一条
  // 已经不在列表里的会话。
  const active = rows.find((row) => row.key === activeKey) ?? idHit ?? rows[0] ?? null;
  const activeIndex = active ? rows.indexOf(active) : -1;
  const highlightedKey = rows.some((row) => row.key === activeKey) ? activeKey : (idHit?.key ?? null);

  // 列表末尾的哨兵进了视口就多要一批。limit 只增不减,上一批没回来时 loaded 不变 ⇒ 同一个 limit,不会连环触发。
  // ❌ 等所有机器都读完再放行:一台慢机器还没回第一页,别的机器已经带回的那些就滚不下去。
  useEffect(() => {
    const node = moreRef.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setLimit((n) => Math.max(n, loaded + BATCH_SIZE));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loaded]);

  // 光标换了一条才把它滚进视野 —— 按 key 认,❌ 按行对象:每一轮刷新、小窗里每来一批,行对象都是新的,
  // 按对象认会把光标那条(缺省是第一条)重新滚进来,正在往下翻的小窗和页面就被拽回顶上。
  const activeRowKey = active?.key ?? null;
  useEffect(() => {
    if (!activeRowKey) return;
    listRef.current
      ?.querySelector(`[data-row-key="${CSS.escape(activeRowKey)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeRowKey]);

  const refreshAll = useCallback(() => {
    refresh();
    sectionGeneration.current += 1;
    setSectionPages({});
    setOpenSections(new Set());
    setLoadingSections(new Set());
  }, [refresh]);

  // 归档 / 恢复不只发生在这个面板里:侧栏、⋯ 菜单、键盘连按两次、手机、agent 的 session_archive 都走那台机器上
  // 同一个 archiveSession / restoreSession,它每收一条、放回一条都发一次带 archivedAt 的 session:changed。
  // 面板开着时跟着它重拉(每台问得到的机器各订一条);面板自己的「恢复」也靠这一条刷新(#6956)。❌ 轮询、❌ 定时刷新:
  // 没有这一条时,手机归档的那一行 10 秒后还写着 Open,点下去等满超时才报「打不开」。
  const reachableKey = reachable.join('\n');
  useEffect(() => {
    const offs = (reachableKey ? reachableKey.split('\n') : []).map((machine) =>
      onMachineEvent(machineArg(machine), sessionChangedChannel, ({ changes }) => {
        if ('archivedAt' in changes) refreshAll();
      })
    );
    return () => offs.forEach((off) => off());
  }, [reachableKey, refreshAll]);

  // 小窗滚到底:按这一节再要一批 —— 这一节在每台在线机器上的每个目录各要一份(同一套筛选,limit 放大;走本机索引的
  // 缓存 —— 目录页那几轮已经把它补新了),归并后截到同一个长度。同一节同时只要一批;回来的比手上的还少(索引在两次
  // 之间变了)就按回来的为准,❌ 拼两份。
  const inFlightSections = useRef(new Set<string>());
  const loadMoreInSection = useCallback(
    (section: HistorySection) => {
      if (inFlightSections.current.has(section.key)) return;
      const have = sectionPages[section.key]?.rows.length ?? section.preview.length;
      const want = have + SECTION_BATCH;
      const generation = sectionGeneration.current;
      inFlightSections.current.add(section.key);
      setLoadingSections((current) => new Set(current).add(section.key));
      const settle = () => {
        inFlightSections.current.delete(section.key);
        setLoadingSections((current) => {
          const next = new Set(current);
          next.delete(section.key);
          return next;
        });
      };
      Promise.all(
        section.members.map(({ machine, directory }) =>
          rpcOn(machineArg(machine))
            .sessionHistory.list({
              source: source === 'all' ? undefined : source,
              status: status === 'all' ? undefined : status,
              query: query.trim() || undefined,
              sort,
              directory,
              limit: want,
              mode: 'cached',
            })
            .then((page) => ({ rows: page.rows.map((row) => entryOf(machine, row)), matched: page.matched }))
        )
      )
        .then((pages) => {
          if (generation !== sectionGeneration.current) return;
          // 在路上时这一节被收起了:这批不要了,❌ 攥在内存里。
          if (!openSectionsRef.current.has(section.key)) return;
          const merged = mergeSorted(pages.map((page) => page.rows), compareSessionHistoryRows(sort)).slice(0, want);
          // 回来的没有比手上多 ⇒ 这一节已经到底(以回来的条数为准),不再要。
          const total = pages.reduce((sum, page) => sum + page.matched, 0);
          const matched = merged.length > have ? total : merged.length;
          setSectionPages((current) => ({ ...current, [section.key]: { rows: merged, matched } }));
        })
        .catch((error: unknown) => {
          if (generation !== sectionGeneration.current) return;
          log.error('load more sessions in a section failed', { key: section.key, error: String(error) });
          setActionError(messageForUser(error));
        })
        .finally(settle);
    },
    [sectionPages, source, status, query, sort]
  );

  // 「显示更多」= 这一节变成限高小窗并当场要下一批;「收起」= 回到只露头几条,多要来的那些行一并扔掉。
  const openSection = (section: HistorySection) => {
    const next = new Set(openSectionsRef.current).add(section.key);
    openSectionsRef.current = next;
    setOpenSections(next);
    loadMoreInSection(section);
  };
  const closeSection = (section: HistorySection) => {
    const next = new Set(openSectionsRef.current);
    next.delete(section.key);
    openSectionsRef.current = next;
    setOpenSections(next);
    setSectionPages((current) => {
      const { [section.key]: _dropped, ...rest } = current;
      return rest;
    });
  };

  const selectRow = (row: HistoryEntry) => {
    setActiveKey(row.key);
    // 点一下展开详情,再点一下收起 —— 详情住在这条下面,❌ 常驻的右栏。
    setExpandedKey((currentKey) => (currentKey === row.key ? null : row.key));
  };

  const openSession = async (ref: Omit<SessionHistoryGuguRef, 'runtime'>, machine: string) => {
    // The one way a session is opened; another machine's with that machine and its project, so one the task list does not
    // draw opens too (the window mounts that machine's projects).
    const deviceId = machineArg(machine);
    try {
      await openLink({ kind: 'session', sessionId: ref.sessionId, projectId: ref.projectId, ...(deviceId ? { deviceId } : {}) });
    } catch (e) {
      log.error('open session from session history failed', { ref, error: String(e) });
      setActionError(messageForUser(e));
    }
  };

  const restore = async (ref: Omit<SessionHistoryGuguRef, 'runtime'>, machine: string) => {
    setActionError(null);
    try {
      const deviceId = machineArg(machine);
      if (deviceId) await remoteHostsStore.syncProjects(deviceId);
      // 会话 id 是这台机器从那台机器的应答里记下的,恢复的调用按它自己选线到那台机器。
      await restoreArchivedSession(ref);
      // 列表不在这里补刷:恢复发出的 session:changed 由上面那条订阅接住。
      toast({ title: translate('sessionHistory.restoredToast') });
    } catch (e) {
      log.error('restore archived session failed', { ref, error: String(e) });
      setActionError(messageForUser(e));
    }
  };

  // 原件在哪台,预览 / 导入就问哪台。
  const importSourceOf = (machine: string): SessionImportSource =>
    resolveImportSource(machine, remoteHostsStore.device(machine)?.directTerminal === true);

  const startImport = async (row: HistoryEntry) => {
    if (!row.local || isImporting) return;
    setIsImporting(true);
    setActionError(null);
    setImportedCount(0);
    setOutcomes(null);
    try {
      // 建在这一行所在的那台机器上:原件在哪台,会话就归哪台。
      const results = await runImport(importSourceOf(row.machine), [row.local], setImportedCount, (e) =>
        describe(e, 'import', row.machine)
      );
      const counts = countOutcomes(results);
      // 只导一条、且成功了 → 直接把用户送进那条会话;批量则留在面板里报账。
      const single = results.length === 1 ? results[0] : null;
      if (single && single.kind !== 'failed') {
        if (single.kind === 'existing') {
          toast({
            title: translate('sessionImport.alreadyImportedTitle'),
            description: translate('sessionImport.alreadyImportedDescription'),
          });
        }
        setIsImporting(false);
        await openSession({ projectId: single.projectId, sessionId: single.sessionId }, row.machine);
        return;
      }
      if (single && single.kind === 'failed') {
        // 导入失败的原文沿用导入面板从前那条文案(describeImportFailure 剥过壳 / 按机器说人话)。
        setActionError(translate('sessionImport.importFailed', { error: single.message }));
        setIsImporting(false);
        return;
      }
      setOutcomes(results);
      setIsImporting(false);
      if (counts.failed === 0) {
        toast({
          title: translate('sessionImport.importedToast', { count: counts.imported }),
          description:
            counts.existing > 0
              ? translate('sessionImport.existingToast', { count: counts.existing })
              : undefined,
        });
      }
      refreshAll();
    } catch (e) {
      log.error('import local session failed', e);
      setActionError(translate('sessionImport.importFailed', { error: describe(e, 'import', row.machine) }));
      setIsImporting(false);
    }
  };

  const runAction = (row: HistoryEntry) => {
    if (row.gugu && row.status === 'active') {
      if (row.opens) void openSession(row.gugu, row.machine);
    } else if (row.gugu && row.status === 'archived') {
      const { projectId, sessionId } = row.gugu;
      void restore({ projectId, sessionId }, row.machine);
    } else void startImport(row);
  };

  // 键盘:上下移光标(跨节)、回车执行这一行的动作。焦点留在搜索框里也能用。
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    const target = event.target as Node | null;
    const fromSearch = target === searchRef.current;
    const fromList = !!target && !!listRef.current?.contains(target);
    if (!fromSearch && !fromList) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const base = activeIndex < 0 ? 0 : activeIndex;
      setActiveKey(rows[(base + delta + rows.length) % rows.length].key);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      runAction(active);
    }
  };

  const filtered = Boolean(query.trim() || source !== DEFAULT_SOURCE || status !== 'all' || machineFilter !== null);
  // 节头的名字 = 项目名;对不上项目的目录 = 目录末级名,完整路径悬停看。
  // 同一页里两节末级名撞了(一堆 …/task-home)才退回末两级,❌ 让两节长得一模一样。
  const labelCounts = new Map<string, number>();
  for (const section of sections) if (section.path) labelCounts.set(section.label, (labelCounts.get(section.label) ?? 0) + 1);
  const sectionLabel = (section: HistorySection) =>
    section.path && (labelCounts.get(section.label) ?? 0) > 1 ? shortenPath(section.path, '') : section.label;
  // 筛选菜单的触发钮上写着当前生效的筛选;默认(咕咕会话、不筛状态 / 时间)就写「咕咕会话」。
  const filterSummary = [
    source === 'all'
      ? translate('sessionHistory.sourceAll')
      : source !== DEFAULT_SOURCE
        ? translate('sessionHistory.sourceLocal', { engine: sourceLabel(source, translate) })
        : null,
    status !== 'all' ? translate(STATUS_MESSAGE_KEY[status]) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // 索引进度:还在补的那几台加起来。
  const indexing = states.flatMap((state) => (state?.isIndexing && state.page?.local ? [state.page.local] : []));
  const localPage = byMachine[LOCAL_IMPORT_DEVICE]?.page;

  return (
    <PageLayout>
      {/* 几何照 设计同事 2026-09-23 的模板图量出来(1728×1050 视口):内容列 768px 居中、标题顶 64px、
          标题到筛选行 48px、筛选行到第一节 36px、节与节之间 48px。 */}
      <PageContent className="flex min-h-0 max-w-3xl flex-col pt-16 pb-12">
        <div ref={rootRef} onKeyDown={handleKeyDown} className="flex min-h-0 flex-col">
          {/* 标题行:左标题,右侧只在批量导入时显示进度(模板右侧是「全部删除」,我们不做删除)。 */}
          <div className="flex min-h-8 items-center justify-between gap-4 [-webkit-app-region:drag]">
            <h2 className="shrink-0 font-display text-2xl leading-8 font-normal text-foreground">{translate('sessionHistory.title')}</h2>
            {isImporting ? (
              <span className="flex items-center gap-2 text-xs text-foreground-muted" role="status" data-testid="session-history-importing">
                <Spinner size="sm" />
                {translate('sessionHistory.importingCount', { count: importedCount })}
              </span>
            ) : <LegacyDmArchiveButton />}
          </div>

          {/* 筛选行(模板):搜索框占满剩余宽度 + 筛选菜单(类型 / 状态 / 排序方式)+ 机器筛选(默认全部机器)。
              搜索框用输入框统一的圆角矩形(与自动化 / 提示词库 / MCP / Agent 设置的搜索框同形),❌ 单独改胶囊(owner 2026-09-27)。 */}
          <div className="mt-12 flex flex-wrap items-center gap-2">
            <SearchInput
              ref={searchRef}
              autoFocus
              value={rawQuery}
              onChange={(event) => setRawQuery(event.target.value)}
              placeholder={translate('sessionHistory.searchPlaceholder')}
              aria-label={translate('sessionHistory.searchLabel')}
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="session-history-list"
              aria-activedescendant={active ? historyOptionId(active.key) : undefined}
              containerClassName="min-w-56 flex-1"
              data-testid="session-history-search"
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    className="w-36 justify-start font-normal text-foreground"
                    data-testid="session-history-filter"
                  />
                }
              >
                <ListFilter className="size-4 text-foreground-muted" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {filterSummary || translate('sessionHistory.filterDefault')}
                </span>
                <ChevronDown className="size-4 text-foreground-muted" />
              </DropdownMenuTrigger>
              {/* 档名带引擎名和「本机未导入」,窄了会折成两行:给够宽度,档名不换行。 */}
              <DropdownMenuContent align="start" className="min-w-56 whitespace-nowrap">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{translate('sessionHistory.colSource')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={source} onValueChange={(value) => setSource(value as SourceFilter)}>
                    <DropdownMenuRadioItem value="all" data-testid="session-history-filter-source-all">
                      {translate('sessionHistory.sourceAll')}
                    </DropdownMenuRadioItem>
                    {SESSION_HISTORY_SOURCES.map((value) => (
                      <DropdownMenuRadioItem key={value} value={value} data-testid={`session-history-filter-source-${value}`}>
                        {/* 本机引擎这几档里全是还没导入的(导入过的已经是咕咕会话),档名上说清楚。 */}
                        {value === 'gugu'
                          ? translate('sessionHistory.filterDefault')
                          : translate('sessionHistory.sourceLocal', { engine: sourceLabel(value, translate) })}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{translate('sessionHistory.colStatus')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={status} onValueChange={(value) => setStatus(value as StatusFilter)}>
                    <DropdownMenuRadioItem value="all" data-testid="session-history-filter-status-all">
                      {translate('sessionHistory.statusAll')}
                    </DropdownMenuRadioItem>
                    {SESSION_HISTORY_STATUSES.map((value) => (
                      <DropdownMenuRadioItem key={value} value={value} data-testid={`session-history-filter-status-${value}`}>
                        {translate(STATUS_MESSAGE_KEY[value])}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{translate('sessionHistory.sortLabel')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as SessionHistorySort)}>
                    {SORT_OPTIONS.map((value) => (
                      <DropdownMenuRadioItem key={value} value={value} data-testid={`session-history-filter-sort-${value}`}>
                        {translate(SORT_KEY[value])}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    className="w-40 justify-start font-normal text-foreground"
                    aria-label={translate('sessionHistory.machineFilter')}
                    data-testid="session-history-machine"
                  />
                }
              >
                <Monitor className="size-4 text-foreground-muted" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {filterChoice?.label ?? translate('sessionHistory.machineAll')}
                </span>
                <ChevronDown className="size-4 text-foreground-muted" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48 whitespace-nowrap">
                <DropdownMenuRadioGroup
                  value={machineFilter ?? ''}
                  onValueChange={(value) => setPickedMachine(value ? (value as string) : null)}
                >
                  <DropdownMenuRadioItem value="" data-testid="session-history-machine-all">
                    {translate('sessionHistory.machineAll')}
                  </DropdownMenuRadioItem>
                  {choices.map((choice) => (
                    <DropdownMenuRadioItem key={choice.id} value={choice.id} data-testid={`session-history-machine-${choice.id}`}>
                      <span className="min-w-0 truncate">{choice.label}</span>
                      {!choice.isLocal && !choice.isOnline ? (
                        <small className="ml-auto pl-3 text-foreground-muted">{translate('machinePicker.offline')}</small>
                      ) : null}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {outcomes ? (
            <div className="mt-6 flex flex-col gap-2">
              <ImportSummary outcomes={outcomes} />
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setOutcomes(null)}>
                {translate('common.close')}
              </Button>
            </div>
          ) : null}

          {/* 某台问不通 / 太旧:那一台说一句(整句由 describeImportFailure 给),别的机器照列。 */}
          {failed.length > 0 ? (
            <div className="mt-6 flex flex-col items-start gap-1" data-testid="session-history-errors">
              {failed.map((machine) => (
                <p key={machine} className="text-sm leading-relaxed text-foreground-destructive">
                  {describe(byMachine[machine]?.cause, 'list', machine)}
                </p>
              ))}
              <Button size="sm" variant="outline" className="mt-2" onClick={refreshAll}>
                {translate('common.retry')}
              </Button>
            </div>
          ) : null}

          {/* 正文:一个项目一节。节头一行在面板外;面板 = 密度底色 + 6px 圆角,无外框、行间无线(ui-visual-spec §6.6)。 */}
          <div
            ref={listRef}
            id="session-history-list"
            role="listbox"
            aria-label={translate('sessionHistory.title')}
            aria-busy={isLoading || isIndexing}
            data-testid="session-history-list"
            className="mt-9 flex flex-col gap-12"
          >
            {sections.length === 0 && isLoading ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-foreground-muted">
                <Spinner size="sm" />
                {translate('sessionImport.loading')}
              </div>
            ) : sections.length === 0 && failed.length === 0 ? (
              <div className="p-8 text-center" data-testid="session-history-empty">
                <p className="text-sm text-foreground-muted">
                  {filtered ? translate('sessionImport.emptyNoMatch') : translate('sessionHistory.emptyNone')}
                </p>
                {isIndexing && (
                  <p className="mt-1 text-xs leading-relaxed text-foreground-tertiary-muted">
                    {translate('sessionImport.emptyHintIndexing')}
                  </p>
                )}
              </div>
            ) : (
              sections.map((section) => {
                const sectionRows = sectionSessions(section);
                const open = isSectionOpen(section);
                return (
                  <section key={section.key} data-testid="session-history-section" data-section-key={section.key}>
                    <div className="mb-3 flex h-7 items-center gap-2 px-2">
                      <Folder className="size-4 shrink-0 text-foreground-muted" />
                      <span
                        className="truncate text-sm text-foreground"
                        title={section.path ?? undefined}
                        data-testid="session-history-section-name"
                      >
                        {sectionLabel(section)}
                      </span>
                      {section.machine && spansMachines ? (
                        <span className="shrink-0 text-sm text-foreground-muted" data-testid="session-history-section-machine">
                          {labelOf(section.machine)}
                        </span>
                      ) : null}
                      {/* 我们的特色之一:这一节里出现过的 agent,一排图标(最多 3 个)。 */}
                      {section.providers.length > 0 ? (
                        <span className="flex shrink-0 items-center gap-1" data-testid="session-history-section-agents">
                          {section.providers.slice(0, SECTION_AGENT_ICONS).map((providerId) => (
                            <AgentIcon key={providerId} id={providerId} size={14} />
                          ))}
                        </span>
                      ) : null}
                      <span className="ml-auto shrink-0 text-sm text-foreground-muted tabular-nums">
                        {translate('sessionHistory.sectionCount', { count: sessionCount(section) })}
                      </span>
                      {/* ❌ 节头 ···(owner 2026-09-26):它里面的「查看全部」与小窗下的「显示更多」重复。 */}
                    </div>
                    <SessionHistorySectionBox
                      capped={open}
                      hasMore={open && sectionHasMore(section)}
                      isLoadingMore={loadingSections.has(section.key)}
                      onReachEnd={() => loadMoreInSection(section)}
                    >
                      {sectionRows.map((row) => (
                        <SessionHistoryRow
                          key={row.key}
                          row={row}
                          isSelected={row.key === active?.key}
                          isHighlighted={row.key === highlightedKey}
                          isExpanded={expandedKey === row.key}
                          onSelect={() => selectRow(row)}
                          onAction={() => runAction(row)}
                          previewSource={importSourceOf(row.machine)}
                          describePreviewError={(e) => describe(e, 'preview', row.machine)}
                          machineLabel={spansMachines ? labelOf(row.machine) : null}
                          offline={row.offline}
                          actionDisabled={row.offline && !row.opens}
                        />
                      ))}
                    </SessionHistorySectionBox>
                    {sectionTruncated(section) || open ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="mt-1 ml-2 text-foreground-muted"
                        data-testid={open ? 'session-history-section-show-less' : 'session-history-section-show-more'}
                        aria-expanded={open}
                        onClick={() => (open ? closeSection(section) : openSection(section))}
                      >
                        {open
                          ? translate('sessionHistory.showLess')
                          : translate('sessionHistory.showMore', { count: sessionCount(section) })}
                      </Button>
                    ) : null}
                    {/* 这一节里有离线机器的行(心跳摘要,只有最近那些):节尾写明哪台离线。 */}
                    {section.offlineMachines.map((machine) => (
                      <p key={machine} className="mt-1 px-2 text-xs text-foreground-muted" data-testid="session-history-section-offline">
                        {translate('sessionHistory.machineOffline', { device: labelOf(machine) })}
                      </p>
                    ))}
                  </section>
                );
              })
            )}
          </div>

          {/* 脚部:滚动加载的哨兵 + 索引进度。模板上没有总计行 —— 总计只给读屏。 */}
          <div ref={moreRef} className="mt-6 flex min-h-4 flex-wrap items-center gap-3 text-xs text-foreground-muted">
            {hasMore ? <Spinner size="sm" /> : null}
            <span data-testid="session-history-total" className="sr-only">
              {translate('sessionHistory.totalDirectories', { count: sections.length })}
            </span>
            {indexing.length > 0 ? (
              <span className="flex items-center gap-2" data-testid="session-history-progress" role="status" aria-live="polite">
                <Spinner size="sm" />
                {translate('sessionImport.indexing', {
                  indexed: indexing.reduce((sum, local) => sum + local.indexed, 0),
                  discovered: indexing.reduce((sum, local) => sum + local.discovered, 0),
                })}
              </span>
            ) : null}
            {localPage && localPage.local === null ? <span>{translate('sessionHistory.localUnavailable')}</span> : null}
          </div>

          {actionError ? (
            <p className="text-sm leading-relaxed text-foreground-destructive">{actionError}</p>
          ) : null}
        </div>
      </PageContent>
    </PageLayout>
  );
});

export function SessionHistoryTitlebar() {
  return <ShellTitlebar />;
}

/** Draws nothing: a view's params are typed from its WrapView's props (`WrapParams`), so `useParams('session-history')` knows them. */
function SessionHistoryViewWrapper({ children }: { children: ReactNode } & SessionHistoryViewParams) {
  return <>{children}</>;
}

export const sessionHistoryView = {
  WrapView: SessionHistoryViewWrapper,
  transientParams: ['source', 'status'],
  TitlebarSlot: SessionHistoryTitlebar,
  MainPanel: SessionHistoryMainPanel,
} satisfies ViewDefinition<SessionHistoryViewParams>;
