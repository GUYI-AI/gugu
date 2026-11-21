import { AppIcon } from '@renderer/lib/components/app-icon';
import type { InstalledItem } from '@renderer/features/extensions/installed/installed-item';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { useAppDetailRequest } from '@renderer/features/apps/use-app-detail-request';
import type { ExtensionAppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { messageForUser } from '@/lib/userFacingError';
import { Archive, CircleAlert, LayoutGrid, Plug, SquareTerminal, Trash2Icon } from '@/lib/icons';
import { UI_EVENTS } from '@/lib/uiEvents';
import { observer } from 'mobx-react-lite';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SurfaceShownContext } from '@/lib/retainedSurface';
import { useDebounce } from '@renderer/lib/hooks/useDebounce';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { setExtensionEnabled } from '@renderer/features/extensions/set-extension-enabled';
import { openApp, openAppInWindow, pinToDock, quitApp, unpinFromDock } from '@renderer/features/extensions/app-dock';
import {
  installedExtensions,
  marketUpdates,
  peekInstalledApps,
  putInstalled,
  setAutoUpdate,
  setDisclosure as setDisclosureOn,
  updateCountOf,
  useInstalledApps,
  type ExtensionDisclosureLevel,
} from '@renderer/features/extensions/installed-extensions';
import { useReplica, refreshFailure } from '@/lib/replica';
import { writeOver } from '@/lib/replicaWrite';
import { Unknown } from '@/components/ui/Unknown';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { NEW_SESSION_DRAFT_KEY, composerDrafts } from '@renderer/features/sessions/composer-drafts';
import { toast } from '@renderer/lib/hooks/use-toast';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { PageHeader } from '@renderer/lib/components/page-header';
import { log } from '@renderer/utils/logger';
import { rpcOn } from '@renderer/lib/ipc';
import { installAgreedOn } from '@shared/extensions/install-agreed-on';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { ConsentPrompt } from '@renderer/features/extensions/extension-consent';
import { ConsentBody } from '@/components/extensionBundle/ConsentDetails';
import { askInShell, installConsentPrompt, type InstallConsentAsk } from '@renderer/features/extensions/install-consent';
import { alsoOnMachines, INSTALL_CONSENT_HUMAN_WINDOW_MS, type InstallGrant, type InstallAlsoOnMachine } from '@shared/extensions/host-actions';
import { findRemoteHostsBridge } from '@shared/remote-hosts';
import { installedElsewhere } from '@renderer/features/extensions/installed-elsewhere';
import { extensionAgentStatus, extensionDataBytes, marketChanged, marketEntry, marketSearch, marketShelf } from '@renderer/features/extensions/market-replicas';
import { revokedPermissions } from './NotificationSettingsCard';
import { AgentMarketContent, type AgentMarketFilter } from '@renderer/features/extensions/panel/agent-market-content';
import { AddConnectorButton, ConnectorMarketPage } from '@renderer/features/extensions/panel/connector-market-page';
import { DesktopExtensionMarket, type DesktopMarketShelf } from '@renderer/features/extensions/panel/desktop-extension-market';
import { AgentDetailModal } from '@renderer/features/settings/agents-page/AgentDetailModal';
import { appLifecycle } from '@renderer/features/extensions/panel/app-lifecycle';
import { MarketDetailDialog } from '@renderer/features/extensions/panel/market-detail-dialog';
import { MarketAgentDetail } from '@renderer/features/extensions/panel/market-detail-agent';
import { MarketExtensionDetail } from '@renderer/features/extensions/panel/market-detail-extension';
import type { ConfirmMarketInstall } from '@renderer/features/extensions/panel/market-detail-install';
import { commitMarketInstall } from '@renderer/features/extensions/panel/market-extension-install-rpc';
import type { AppLifecycle } from '@renderer/features/extensions/panel/app-lifecycle-button';
import { AppManagePage } from '@renderer/features/extensions/panel/app-manage-page';
import { AppProductPage, type ExtensionDetailSubject } from '@renderer/features/extensions/panel/app-product-page';
import { AppPromptsSection } from '@renderer/features/library/prompts/prompt-library-view';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { InstalledAppRow } from '@renderer/features/extensions/panel/app-rows';
import { InstalledAgentRows, useInstalledAgentRows } from '@renderer/features/extensions/panel/installed-agent-rows';
import {
  InstalledRowNoticeLine,
  programFailureText,
  type InstalledRowNotice,
} from '@renderer/features/extensions/panel/installed-extension-row';
import type { ExtensionPendingAction } from '@renderer/features/extensions/panel/extension-pending';
import { ExtensionMonogram } from '@renderer/features/extensions/panel/extension-monogram';
import {
  InstalledRowsSkeleton,
  ShelfSkeleton,
} from '@renderer/features/extensions/panel/extension-skeletons';
import '@renderer/features/extensions/panel/extensions-panel.css';
import '@renderer/features/extensions/panel/app-store.css';
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  declaredPermissions,
  INSTALLED_GROUP_ORDER,
  installedGroupOf,
  localizedManifestText,
  marketCategoryOf,
  matchesExtensionQuery,
  type InstalledUpdateFlag,
  type MarketCategory,
} from '@shared/extensions/catalog';
import type {
  MarketListItem,
  MarketSourceRef,
} from '@shared/extensions/market';
import { marketDownloadProgressChannel, marketRefreshedChannel } from '@shared/extensions/marketEvents';
import type { MarketRefreshed } from '@shared/extensions/market-snapshot';
import { ASSISTANT_APP_ID } from '@shared/extensions/assistant-entry';
import { declaredContexts, type ExtensionManifest } from '@shared/extensions/manifest';
import { readCachedDevices } from '@/store/devicesCache';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

export type MarketplaceTab = 'agents' | 'market' | 'connectors';

/** 清单上的一条:manifest 画卡片,ref 说装的时候装哪一版,cloud 是清单上那一版的其余
 *  (版本、兼容、弃用、图标、更新说明、代码在哪,#5410)。 */
type ShelfItem = MarketListItem;

/**
 * The shelf, as this screen has read it so far. 一页一页取(#5410):`items` 是已经取到的
 * 那几页拼起来的,`total` 是服务端说的总数,`hasMore` 决定底部要不要再取;换搜索词从第 0 页重来。
 */
type ShelfState = DesktopMarketShelf | { status: 'loading' | 'error' };

/**
 * 常驻的 App 页(apps-views `retained`)切走再回来不重挂,所以「打开这一页」= 每次重新看见。两次之间至少隔这么久:目录自己
 * `max-age=60`,隔不到一分钟再取,Chromium 的 HTTP 缓存答的还是同一份。
 */
export const MARKET_REOPEN_MIN_MS = 60_000;

/** The permissions taken back from one App, in a list read (an App it names none for has none taken back). */
function takenBack(byApp: Record<string, string[]>, extensionId: string): string[] {
  return byApp[extensionId] ?? [];
}

/** 「上次更新于」的那个时刻:今天的只写几点几分,不是今天的带上日期。 */
function marketStaleTime(iso: string, locale: string): string {
  const at = new Date(iso);
  const today = new Date().toDateString() === at.toDateString();
  return new Intl.DateTimeFormat(
    locale,
    today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  ).format(at);
}


/** Which page of an App is open, and the one the back button returns to. */
export type AppDetail =
  | { page: 'market'; subject: Omit<ExtensionDetailSubject, 'installedVersion'>; from?: AppDetail }
  | { page: 'manage'; extensionId: string; from?: AppDetail; fromApp?: boolean };

const appDetailId = (detail: AppDetail) => (detail.page === 'market' ? detail.subject.manifest.id : detail.extensionId);

export const ExtensionsSettingsCard = observer(function ExtensionsSettingsCard({ detailLink, onOpenAgentDetail, marketPage, onMarketPageChange, onCloseDetailLink, openInstalled, renderInstalledApps, onOpenInstalledApp }: {
  detailLink?: ExtensionAppDetailLink;
  onCloseDetailLink?: () => void;
  marketPage?: MarketplaceTab;
  onMarketPageChange?: (page: MarketplaceTab) => void;
  onOpenAgentDetail?: (agentId: string) => void;
  openInstalled?: () => void;
  renderInstalledApps?: (items: readonly InstalledItem[], state: { loading?: boolean; error?: boolean }) => ReactNode;
  onOpenInstalledApp?: (extensionId: string) => void;
}) {
  const { translate, locale } = useSessionMessages();
  const inventoryOnly = !!renderInstalledApps;
  // #6264 资源库看的是哪台咕咕:本机是全局那份清单与 `rpc.extensions`;另一台咕咕桌面是它自己的那份,
  // 动作经设备 RPC 转到它的主进程,它自己的窗口跟着补上 / 撤下 tab。页面长相不变。
  const library = useLibraryHost();
  const host = library.extensions;
  const api = host.api;
  const remote = library.remote;
  // 看的是另一台机器、它此刻连不上:市场清单问不了(问了只会挂满超时)。
  const machineOffline = Boolean(remote && !remote.online);
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const hostKeyRef = useRef(host.key);
  hostKeyRef.current = host.key;
  // A machine that is offline is not asked; what was read of it is drawn read-only (this and the three reads below).
  const installed = useInstalledApps(host.key, { read: !machineOffline });
  const apps = installed.state === 'value' ? installed.value : null;
  const updatesReading = useReplica(marketUpdates, [host.key], { read: !machineOffline });
  const updates = updatesReading.state === 'value' ? updatesReading.value.summary ?? null : null;
  // 别的机器读清单没读到(离线 / server 太旧 / 问不通):页面上说一句人话,❌ 弹一条带原文的失败 toast。
  const revokedReading = useReplica(revokedPermissions, [host.key], { read: !machineOffline });
  const revoked = revokedReading.state === 'value' ? revokedReading.value : null;
  // #6387
  const agentStatusReading = useReplica(extensionAgentStatus, [host.key], { read: !machineOffline });
  const agentStatus = agentStatusReading.state === 'value' ? agentStatusReading.value : null;
  const inventoryError = refreshFailure(installed) ?? refreshFailure(revokedReading) ?? refreshFailure(agentStatusReading);
  const notice = deviceScopeNotice(
    { remote, error: inventoryError, hasData: installed.state === 'value', now: Date.now(), cloud: remoteHostsStore.cloudScope(remote?.deviceId) },
    translate
  );
  const showConfirm = useShowModal('confirmActionModal');
  const { navigate } = useNavigate();
  const [tab, setTab] = useState<MarketplaceTab | 'installed'>(marketPage ?? 'agents');
  useEffect(() => {
    if (marketPage) setTab(marketPage);
  }, [marketPage]);
  const [agentCategory, setAgentCategory] = useState<AgentMarketFilter>('all');
  const [chip, setChip] = useState<'all' | MarketCategory>('all');
  const [agentDetailId, setAgentDetailId] = useState<string | null>(null);
  const [marketDetail, setMarketDetail] = useState<{ agentId: string } | { item: ShelfItem } | null>(null);
  const closeMarketDetail = () => setMarketDetail(null);
  // 刚在产品页里装好的那一个:那一页头下面说一句「装好了」和去哪找它。
  const [justInstalled, setJustInstalled] = useState<string | null>(null);
  // 进产品页从顶上看起;回清单回到刚才滚到的地方(照 Mac App Store 的返回)。滚的是外面那一层页面。
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => !!element && !!rootRef.current?.contains(element),
    getCommands: () => !searchRef.current?.isConnected ? [] : [{ id: 'app.find', hideFromPalette: true, execute: () => searchRef.current?.focus() }],
  });

  const listScroll = useRef(0);
  const scroller = () => {
    let node = rootRef.current?.parentElement ?? null;
    // 这一页所在那扇窗自己的 getComputedStyle(单独成窗时不是主窗那一个)。
    while (node && !/(auto|scroll)/.test(node.ownerDocument.defaultView?.getComputedStyle(node).overflowY ?? '')) node = node.parentElement;
    return node;
  };
  const [query, setQuery] = useState('');
  const installedAgents = useInstalledAgentRows(query);
  // 搜索词打到服务端去,所以敲字要缓一拍 —— 每个字符一趟请求是在替用户刷自己的清单接口。
  const debouncedQuery = useDebounce(tab === 'market' ? query.trim() : '', 250);
  // Loading more is a new key: the pages already drawn stay drawn from the previous key until it lands, and when it fails.
  const [paging, setPaging] = useState({ query: '', pages: 1 });
  const pages = paging.query === debouncedQuery ? paging.pages : 1;
  const shelfReading = useReplica(marketShelf, machineOffline || inventoryOnly ? null : [host.key]);
  const searchArgs: [string, string, number] | null = machineOffline || inventoryOnly || debouncedQuery === '' ? null : [host.key, debouncedQuery, pages];
  const searchReading = useReplica(marketSearch, searchArgs);
  const searchBefore = useReplica(marketSearch, searchArgs && pages > 1 ? [host.key, debouncedQuery, pages - 1] : null, { read: false });
  const fullShelf = shelfReading.state === 'value' ? shelfReading.value : null;
  // A failed read is said above the market with a retry; what was read stays drawn.
  const shownFailure = debouncedQuery === '' ? refreshFailure(shelfReading) : refreshFailure(searchReading);
  const shelf: ShelfState = useMemo((): ShelfState => {
    if (debouncedQuery === '') {
      if (fullShelf) return { ...fullShelf, status: 'ready', query: '', hasMore: false, loadingMore: false };
      return shelfReading.state === 'error' ? { status: 'error' } : { status: 'loading' };
    }
    const read = searchReading.state === 'value' ? { found: searchReading.value, loadingMore: false }
      : searchBefore.state === 'value' ? { found: searchBefore.value, loadingMore: searchReading.state === 'unknown' } : null;
    if (!read) return searchReading.state === 'error' ? { status: 'error' } : { status: 'loading' };
    return { ...read.found, status: 'ready', query: debouncedQuery, loadingMore: read.loadingMore };
  }, [debouncedQuery, fullShelf, shelfReading.state, searchReading, searchBefore]);
  const retryShelf = () => {
    if (debouncedQuery === '') void marketShelf.refresh(host.key);
    else void marketSearch.refresh(host.key, debouncedQuery, pages);
  };
  // 后台那趟没取到:手上那份照旧画,页头安静写一句「上次更新于 …」(那份的时刻)。❌ 弹错、❌ 错误面板。
  const [marketStale, setMarketStale] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const detailRef = useRef(detail);
  detailRef.current = detail;
  // What is in flight, in two copies: the state is what the screen draws, the
  // ref is what the guards read. A guard on state alone lets a double click
  // through — both clicks land in the same tick, before the first has rendered
  // (the browser test fires consent twice synchronously and got two installs).
  const [pending, setPending] = useState<Record<string, ExtensionPendingAction>>({});
  const inFlight = useRef<Record<string, ExtensionPendingAction>>({});
  const beginPending = (extensionId: string, action: ExtensionPendingAction) => {
    inFlight.current = { ...inFlight.current, [extensionId]: action };
    setPending(inFlight.current);
  };
  const endPending = (extensionId: string) => {
    const { [extensionId]: _done, ...rest } = inFlight.current;
    inFlight.current = rest;
    setPending(rest);
    setDownloadPercent((current) => {
      const { [extensionId]: _dropped, ...restPercent } = current;
      return restPercent;
    });
  };
  // 下载中那个百分比,按 extensionId 存,和 pending 分开放:pending 只是「在忙一件事」
  // 这一个词,percent 只在下载云端包那一段才有意义(#5410)。
  const [downloadPercent, setDownloadPercent] = useState<Record<string, number>>({});
  useEffect(
    () =>
      host.onEvent(marketDownloadProgressChannel, ({ extensionId, received, total }) => {
        // 只更新正在等这个包的那一格:一个先前失败又被别处重试的下载,不该把别的进度条
        // 也拖着走。
        if (!(extensionId in inFlight.current)) return;
        beginPending(extensionId, 'downloading');
        setDownloadPercent((current) => ({
          ...current,
          [extensionId]: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        }));
      }),
    []
  );
  // Permission switches in flight, as `<extensionId>\u0000<permission>`, same shape.
  const [pendingPermissions, setPendingPermissions] = useState<Record<string, true>>({});
  const permissionsInFlight = useRef<Record<string, true>>({});
  // On/off switches in flight, by extension id.
  const [switching, setSwitching] = useState<Record<string, true>>({});


  // `useSessionMessages` hands back a fresh closure every render, so keying an
  // effect on it turns "read once on mount" into "read on every render" — and
  // since the read writes the observable store this component observes, that is
  // an unbounded loop hammering IPC. Hold the current one in a ref instead and
  // let `refresh` be what it actually is: an action, not a render-derived value.
  const translateRef = useRef(translate);
  translateRef.current = translate;


  const refresh = useCallback(async () => {
    try {
      // Both reads, every time. `refresh` is called precisely at the moments the
      // inventory changed — after an install, after an uninstall — so gating it
      // on `isLoaded` made it a no-op exactly then: on the real machine an
      // uninstalled extension kept its card, with live-looking switches, while
      // `extensions.list` had already dropped it. (The same guard previously
      // skipped the withdrawal read as well, drawing every switch ON while main
      // enforced a host as off.) The screen that manages this inventory reads
      // it; one list call is not worth a stale one.
      const hostKey = hostKeyRef.current;
      // What the market says is about what is installed: read again with it (unread, the page's own read is on its way).
      if (marketUpdates.peek(hostKey).state !== 'unknown') void marketUpdates.refresh(hostKey);
      // Not read yet: the read this page's mount began is the one (❌ a second); read already: read again now. A read that
      // fails is thrown (❌ every switch drawn on while main enforces one off).
      await Promise.all([installedExtensions, revokedPermissions, extensionAgentStatus]
        .map((model) => (model.peek(hostKey).state === 'unknown' ? model.fetch(hostKey) : model.reread(hostKey))));
    } catch (error) {
      log.error('extension inventory unreadable:', error);
      // 别的机器:那一句话在页头(deviceScopeNotice,从读数来),不弹 toast。
      if (remoteRef.current) return;
      // The toast reaches whoever is on the other tab.
      toast({
        title: translateRef.current('extensions.loadFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: { label: translateRef.current('extensions.retry'), onClick: () => void refresh() },
      });
    }
  }, []);

  // A page that failed is read again by its retry (❌ the next one asked past it).
  const canLoadMore = shelf.status === 'ready' && shelf.hasMore && !shelf.loadingMore && shownFailure === null;
  const loadMore = () => {
    if (!canLoadMore || debouncedQuery === '') return;
    setPaging({ query: debouncedQuery, pages: pages + 1 });
  };

  // 底部哨兵:滚到它就取下一页 —— 往下滚本身就是「我还要看」,❌ 不再要一次点击
  // (owner 2026-09-14:「我不要手动点才能加载更多,下滚不就可以加载更多了吗」)。
  // 翻页看不看得见,靠的是一页只放 12 张、底下写着取到第几条,不是靠一个按钮。
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMoreRef.current();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  // 产品页铺开时整个清单卸掉、页脚那一行跟着没了;回来以后是新的一行,要重新盯上(`detail` 进依赖)。
  }, [canLoadMore, tab, detail]);

  const detailId = detail ? `${detail.page}:${appDetailId(detail)}` : null;
  useLayoutEffect(() => {
    const page = scroller();
    if (page) page.scrollTop = detailId ? 0 : listScroll.current;
  }, [detailId]);

  /**
   * 一个扩展当前在市场上的那一版:先看已经取到的页(清单是分页的),没有就定点问一次。
   * null = 市场里没有它;市场读不到就 reject —— 两者对人说的不一样。
   */
  const shelfItemFor = useCallback(
    async (extensionId: string): Promise<ShelfItem | null> =>
      fullShelf?.items.find((item) => item.manifest.id === extensionId) ?? (await marketEntry.fetch(hostKeyRef.current, extensionId)),
    [fullShelf]
  );
  const withShelfItem = async (extensionId: string, name: string, act: (item: ShelfItem) => void): Promise<void> => {
    try {
      const item = await shelfItemFor(extensionId);
      if (item) act(item);
      else toast({ title: translate('extensions.notInMarket', { name }), tier: 'error' });
    } catch (error) {
      log.warn('market entry unreadable:', error);
      toast({
        title: translate('extensions.marketUnavailable'),
        tier: 'error',
        action: { label: translate('extensions.retry'), onClick: () => void withShelfItem(extensionId, name, act) },
      });
    }
  };

  // 下载站那一趟回来了(打开这一页时去的那趟,或者别处 —— 启动、安装 —— 去的):变了,市场这一块和「有新版 / 被撤回」
  // 一起从新的那份重读(两边永远是同一刻,10-08 的一致性);没变什么都不重画;没取到,照旧画手上那份、页头写「上次更新于 …」。
  const fullShelfRef = useRef(fullShelf);
  fullShelfRef.current = fullShelf;
  const onMarketRefreshed = (refreshed: MarketRefreshed) => {
    if (refreshed.outcome === 'failed') {
      setMarketStale(refreshed.fetchedAt);
      return;
    }
    setMarketStale(null);
    // 变了:这台机器的市场那几份重读(推送和回答报的同一刻只读一回,marketChanged 按那一刻去重);画着的那份就是这一刻的也不读。
    if (refreshed.outcome !== 'changed' || refreshed.fetchedAt === fullShelfRef.current?.fetchedAt) return;
    if (!marketChanged(host.key, refreshed.fetchedAt)) return;
    // 本机那份「有新版」由 wireMarketRefresh 跟着推送重查;别的机器的推送未必转得过来,这里查。
    if (!host.local) void marketUpdates.refresh(host.key);
  };
  const onMarketRefreshedRef = useRef(onMarketRefreshed);
  onMarketRefreshedRef.current = onMarketRefreshed;
  useEffect(() => {
    if (inventoryOnly) return;
    return host.onEvent(marketRefreshedChannel, (refreshed) => onMarketRefreshedRef.current(refreshed));
  }, [host, inventoryOnly]);

  const shown = useContext(SurfaceShownContext);
  useEffect(() => {
    if (!shown) setMarketDetail(null);
  }, [shown]);
  const openedAt = useRef<number | null>(null);
  useEffect(() => {
    // 那台机器离线:一问都不发(问不到只会挂满超时),照旧画上次读到的那份、只读。
    if (!shown || (remote && !remote.online)) return;
    if (openedAt.current !== null && Date.now() - openedAt.current < MARKET_REOPEN_MIN_MS) return;
    openedAt.current = Date.now();
    // With it 「有什么要告诉你的」 too (spec:启动时一次、打开设置页时一次,❌ 轮询;启动时那一次是 wire-market-refresh 的)。
    void refresh();
    if (inventoryOnly) return;
    // 这一次和下面的市场清单都先从那台机器手上的目录答(❌ 等下载站);同时让它去下载站取一趟,回来的结果走
    // onMarketRefreshed。结果用回答带回:别的机器的推送未必转得到这个窗口。比这一版旧的机器没有这一问,照旧现取。
    void api
      .marketRefresh()
      .then((result) => {
        if (result.success && result.data) onMarketRefreshedRef.current(result.data);
      })
      .catch((error: unknown) => log.warn('App market refresh not asked:', error));
  }, [refresh, shown, inventoryOnly]);

  /**
   * 从市场装:装法只有一条 —— main 的 installExtensionFromMarket(群里的「用 X 打开」、首启那一页、agent 的 app_install 走的
   * 也是它,161 10-15)。main 下载、比对指纹、解包、读 manifest,把要问的交回来(`consent: return`);这个窗口问(另一台
   * 机器的 App 也在这里问),点了头再带着指纹去装(`given`,用的就是刚才那一份,不再下一遍)。下载进度照旧推给卡片。
   *
   * ⚠️ 用户点头的是「这个包声明了什么」:main 读的是解开的那一份 manifest,不是清单上那张卡片写的。
   */
  const installFromShelf = useCallback(
    async (ref: MarketSourceRef, extensionId?: string, options: { confirm?: ConfirmMarketInstall; singleMachine?: boolean } = {}) => {
      const { confirm, singleMachine = false } = options;
      if (extensionId) {
        if (inFlight.current[extensionId]) return;
        beginPending(extensionId, 'inspecting');
      }
      try {
        const handed = await api.installFromMarket({ ref, consent: { kind: 'return' } });
        if (!handed.success || !handed.data) throw new Error(handed.error ?? '');
        if (handed.data.outcome !== 'ask') return;
        const { ask, asks } = handed.data;
        if (confirm) {
          if (await confirm(ask, asks)) await completeMarketInstall(ask, true);
          return;
        }
        // 第一次装、什么都不要的,以及同来源、不多要权限的更新:点「安装」本身就是同意(main 的 installPlan 判的,
        // #7059 原型「什么权限都不要的直接装」)。
        if (!asks) {
          if (extensionId) endPending(extensionId);
          await completeMarketInstall(ask);
          return;
        }
        // Installing on another machine: the sheet names it, every sentence (main there does not know it is asked from here).
        const machine = remoteRef.current?.deviceLabel;
        const prompt = installConsentPrompt(machine ? { ...ask, machine } : ask, ask.manifest);
        // owner 10-16「装的时候一次选好装到哪几台」: the person's other online computers, each by name, ticked in the same sheet.
        const alsoOn = singleMachine ? undefined : alsoOnMachines(findRemoteHostsBridge()?.listDevices() ?? [], remoteRef.current?.deviceId);
        await askToInstall(prompt, ask.manifestDigest, ask.given, async (also) => {
          await completeMarketInstall(ask);
          for (const deviceId of also ?? []) await installOnAlso(deviceId, alsoOn?.find((one) => one.id === deviceId)?.label ?? deviceId, ask);
        }, machine, alsoOn, singleMachine);
      } catch (error) {
        log.error('extension market install failed:', error);
        toast({
          title: translateRef.current('extensions.installFailed'),
          description: messageForUser(error),
          tier: 'error',
          action: {
            label: translateRef.current('extensions.retry'),
            onClick: () => void installFromShelf(ref, extensionId, options),
          },
        });
      } finally {
        if (extensionId) endPending(extensionId);
      }
    },
    [showConfirm]
  );

  const switchVariant = async (manifest: ExtensionManifest, name: string) => {
    if (inFlight.current[manifest.id]) return;
    beginPending(manifest.id, 'inspecting');
    try {
      const handed = await api.switchVariant(manifest.id, name, { kind: 'return' });
      if (!handed.success || !handed.data) throw new Error(handed.error ?? 'App variant unreadable');
      if (handed.data.outcome !== 'ask') { await refresh(); return; }
      const { ask, asks } = handed.data;
      const complete = () => installing(
        ask.manifest,
        () => api.switchVariant(manifest.id, name, { kind: 'given', digest: ask.manifestDigest }),
        () => switchVariant(manifest, name),
      );
      if (!asks) { await complete(); return; }
      const machine = remoteRef.current?.deviceLabel;
      const prompt = installConsentPrompt(machine ? { ...ask, machine } : ask, ask.manifest);
      await askToInstall(prompt, ask.manifestDigest, ask.given, complete, machine);
    } catch (error) {
      toast({ title: translateRef.current('extensions.switchFailed'), description: messageForUser(error), tier: 'error' });
    } finally {
      endPending(manifest.id);
    }
  };

  /**
   * One way to ask, for every install here: with 「给哪些 agent」 (D-30) in the shell's sheet, else in the session page's own
   * dialog. `agreed` runs on a yes; this resolves once the shell's sheet is answered (the dialog answers on its own).
   */
  const askToInstall = async (
    prompt: ConsentPrompt,
    digest: string,
    given: InstallGrant | undefined,
    agreed: (alsoOn?: string[]) => Promise<void>,
    /** Another machine's App page: the one it installs on (its agents are that machine's). */
    machine?: string,
    /** owner 10-16: the person's other computers it may also go on, with the same yes. */
    alsoOn?: InstallAlsoOnMachine[],
    waitForAnswer = false
  ) => {
    const inShell = given || alsoOn?.length || waitForAnswer
      ? askInShell(prompt, `${digest}:${Date.now()}`, INSTALL_CONSENT_HUMAN_WINDOW_MS, given, undefined, machine, alsoOn)
      : null;
    if (inShell) {
      const answer = await inShell;
      if (answer.outcome === 'confirmed') await agreed(answer.alsoOn);
      return;
    }
    const description = prompt.details ? <ConsentBody description={prompt.description} details={prompt.details} /> : prompt.description;
    if (waitForAnswer) {
      await new Promise<void>((resolve, reject) => showConfirm({
        ...prompt,
        description,
        onSuccess: () => { void agreed().then(resolve, reject); },
        onClose: resolve,
      }));
      return;
    }
    showConfirm({ ...prompt, description, onSuccess: () => void agreed() });
  };

  /** owner 10-16 The same release on another of the person's computers, with the yes given in the sheet (`installAgreedOn`). */
  const installOnAlso = async (deviceId: string, label: string, ask: InstallConsentAsk): Promise<void> => {
    try {
      const ref = { extensionId: ask.manifest.id, version: ask.manifest.version };
      await installAgreedOn((consent) => rpcOn(deviceId).extensions.installFromMarket({ ref, consent }), async () => ({ digest: ask.manifestDigest }));
      toast({ title: translateRef.current('extensions.bundleCardInstalledOn', { machine: label }), tier: 'success' });
    } catch (error) {
      log.error('extension market install on another computer failed:', { deviceId, error });
      toast({
        title: translateRef.current('extensions.installFailedOn', { machine: label }),
        description: messageForUser(error),
        tier: 'error',
        action: { label: translateRef.current('extensions.retry'), onClick: () => void installOnAlso(deviceId, label, ask) },
      });
    }
  };

  /** A market App the person agreed to (`given`): main installs the very bytes it read for that consent. */
  const completeMarketInstall = (ask: InstallConsentAsk, marketDialog = false): Promise<void> =>
    installing(
      ask.manifest,
      () => marketDialog ? commitMarketInstall(api, ask) :
        api.installFromMarket({
          ref: { extensionId: ask.manifest.id, version: ask.manifest.version },
          consent: { kind: 'given', digest: ask.manifestDigest },
        }),
      () => completeMarketInstall(ask, marketDialog)
    );

  /** Installing one App, as its card shows it: busy, then the list read again, its tabs, 「装好了」 — or why not, with a retry. */
  const installing = async (
    manifest: ExtensionManifest,
    run: () => Promise<{ success: boolean; error?: string }>,
    retry: () => Promise<void>
  ) => {
    if (inFlight.current[manifest.id] === 'installing') return;
    beginPending(manifest.id, 'installing');
    // 「装好了」那句只给第一次装上的;更新、换版本不说(它本来就在)。
    // @@@reading-default(moment) - one install's 「装好了」 line: the list not known yet counts as not installed before (a first install)
    const firstInstall = apps === null || !apps.manifests.some((entry) => entry.id === manifest.id);
    try {
      const result = await run();
      if (!result.success) {
        throw new Error(result.error ?? '');
      }
      // This window's tab providers follow the list, no restart; another machine's follow in its own window.
      // With what is installed, its 「有新版」 (cleared, or the next one after the version just installed).
      await refresh();
      if (firstInstall) setJustInstalled(manifest.id);
      // "Did it work" and "what next" in one breath: the tab is where it went.
      // What a task's「+」lists: the App's own page, by its name in this language (installedExtensions → mainTabOf); an App
      // whose tabs only open files or come one per task has nothing there to put, and says nothing about it.
      const name = localizedManifestText(manifest, locale).name;
      const hasPage = manifest.contributes.tabs.some((tab) => declaredContexts(tab).length === 0 && !tab.perSession);
      toast({
        title: translateRef.current(firstInstall ? 'extensions.installed' : 'marketDetail.updated', { name }),
        ...(hasPage ? { description: translateRef.current('extensions.installedNext', { name }) } : {}),
        tier: 'success',
      });
    } catch (error) {
      // Consent was given for this digest; retrying resends it, and the installer
      // still refuses if what it reads changed underneath.
      toast({
        title: translateRef.current('extensions.installFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: {
          label: translateRef.current('extensions.retry'),
          onClick: () => void retry(),
        },
      });
    } finally {
      endPending(manifest.id);
    }
  };

  /**
   * Optimistic: the switch moves on the click and the write follows. If the
   * write fails the switch moves back and says why, with a way to try again.
   * Holding the switch still until IPC returns made every toggle feel ignored.
   */
  const setPermissionGranted = async (
    manifest: ExtensionManifest,
    permission: string,
    granted: boolean
  ) => {
    const key = `${manifest.id}\u0000${permission}`;
    if (permissionsInFlight.current[key]) return;
    permissionsInFlight.current = { ...permissionsInFlight.current, [key]: true };
    setPendingPermissions(permissionsInFlight.current);
    const apply = (list: readonly string[], on: boolean) =>
      on ? list.filter((entry) => entry !== permission) : [...new Set([...list, permission])];
    const take = (revoked: (current: string[]) => string[]) => (current: Record<string, string[]> | undefined) =>
      current && { ...current, [manifest.id]: revoked(current[manifest.id] ?? []) };
    try {
      // What main enforces wins over what was assumed; refused and unreadable again, back to what was read before (I4).
      await writeOver(revokedPermissions, [host.key], take((list) => apply(list, granted)), async () => {
        const result = await api.setPermissionGranted({ extensionId: manifest.id, permission, granted });
        if (!result.success || !result.data) throw new Error(result.error ?? '');
        return result.data.revoked;
      }, (settled) => take(() => settled));
    } catch (error) {
      toast({
        title: translateRef.current('extensions.permissionChangeFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: {
          label: translateRef.current('extensions.retry'),
          onClick: () => void setPermissionGranted(manifest, permission, granted),
        },
      });
    } finally {
      const { [key]: _done, ...rest } = permissionsInFlight.current;
      permissionsInFlight.current = rest;
      setPendingPermissions(rest);
    }
  };

  /** 可用/不可用 — the rung between installed and uninstalled; optimistic, with rollback. */
  const switchExtension = async (manifest: ExtensionManifest, enabled: boolean) => {
    if (switching[manifest.id]) return;
    setSwitching((current) => ({ ...current, [manifest.id]: true }));
    try {
      await setExtensionEnabled(manifest, enabled, host);
    } catch (error) {
      log.error('extension switch refused:', error);
      toast({
        title: translateRef.current('extensions.switchFailed'), description: messageForUser(error),
        tier: 'error',
        action: {
          label: translateRef.current('extensions.retry'),
          onClick: () => void switchExtension(manifest, enabled),
        },
      });
    } finally {
      setSwitching(({ [manifest.id]: _done, ...rest }) => rest);
    }
  };

  // The far-left rail is this machine's: its own Apps that are on and have a page of their own (no file to open).
  // 「打开」 in an App's details goes by the same rule: it does what the App's icon on the rail does.
  const onRail = (manifest: ExtensionManifest) =>
    !remote && apps !== null && apps.isEnabled(manifest.id) && !apps.isPreinstalled(manifest.id) && Boolean(apps.mainTabOf(manifest.id));
  const dockToggle = (manifest: ExtensionManifest) =>
    !onRail(manifest)
      ? undefined
      : () =>
          void (apps!.dock.includes(manifest.id) ? unpinFromDock : pinToDock)(manifest.id).catch((error: unknown) => {
            log.error('dock change refused:', error);
            toast({ title: translateRef.current('extensions.dockFailed'), description: messageForUser(error), tier: 'error' });
          });
  const setDisclosure = async (manifest: ExtensionManifest, level: ExtensionDisclosureLevel) => {
    try {
      await setDisclosureOn(host.key, manifest.id, level);
    } catch (error) {
      log.error('extension disclosure refused:', error);
      toast({ title: translateRef.current('extensions.disclosureFailed'), description: messageForUser(error), tier: 'error' });
    }
  };

  // #6646 The chat's own forward page sends it (ExtensionForwardHost); exporting to a file is a row there.
  const forwardExtension = (manifest: ExtensionManifest) => {
    setDetail(null);
    window.dispatchEvent(new CustomEvent(UI_EVENTS.forwardExtension, { detail: { extensionId: manifest.id, name: localizedManifestText(manifest, locale).name, version: manifest.version } }));
  };

  /**
   * Every App goes out one way, a readable one or a folder no manifest this build runs (an older apiVersion among
   * them) — that one by its folder name, which is its id.
   */
  const confirmUninstall = (app: { id: string; name: string }) => {
    showConfirm({
      title: translate('extensions.uninstallConfirmTitle', { name: app.name }),
      description: translate('extensions.uninstallConfirmDescription', { name: app.name }),
      confirmLabel: translate('extensions.uninstallAction'),
      variant: 'destructive',
      onSuccess: () => void uninstall(app),
    });
  };

  /**
   * Main's uninstall, and nothing else: its tabs are taken back by the inventory event every window follows
   * (`extensionsInventoryChangedChannel` → `resyncInstalledExtensionTabs`), which main sends before it answers.
   */
  const uninstall = async (app: { id: string; name: string }) => {
    if (inFlight.current[app.id]) return;
    beginPending(app.id, 'uninstalling');
    try {
      // A machine picked in the device picker that cannot be reached rejects instead of answering: the same failure.
      // I10 Off the last of the person's computers: its grants in chats go with it.
      const lastAnywhere = !(await installedElsewhere(app.id, remoteRef.current?.deviceId ?? null));
      const result = await host.api.uninstall({ extensionId: app.id, lastAnywhere });
      if (!result.success) throw new Error(result.error ?? '');
      await refresh();
      // 它的设置页随它一起没了:回到进来的地方(市场页还在,按钮回到「安装」);从别处直接进来的回「已安装」。
      const leaving = detailRef.current;
      if (leaving?.page === 'manage' && leaving.extensionId === app.id) {
        if (!leaving.from) {
          onCloseDetailLink?.();
          if (openInstalled) openInstalled();
          else setTab('installed');
        }
        setDetail(leaving.from ?? null);
      }
      setJustInstalled((current) => (current === app.id ? null : current));
      // Uninstall is the one irreversible action here. When the bundle is on the
      // shelf the way back is one click on the toast; a hand-picked folder has
      // no shelf copy, so the toast only reports.
      // The market unreadable is said as such; its 「重新安装」 asks the market again on the click.
      const onShelf = await shelfItemFor(app.id).catch((error: unknown) => {
        log.warn('market entry unreadable:', error);
        return 'unreadable' as const;
      });
      const reinstall = () => void withShelfItem(app.id, app.name, (item) => void installFromShelf(item.ref, app.id));
      toast({
        title: translate('extensions.uninstalled', { name: app.name }),
        tier: 'success',
        ...(onShelf === 'unreadable'
          ? { description: translate('extensions.reinstallMarketUnreadable'), action: { label: translate('extensions.reinstall'), onClick: reinstall } }
          : onShelf && { action: { label: translate('extensions.reinstall'), onClick: () => void installFromShelf(onShelf.ref, app.id) } }),
      });
    } catch (error) {
      toast({
        title: translate('extensions.uninstallFailed'),
        description: messageForUser(error),
        tier: 'error',
        action: { label: translate('extensions.retry'), onClick: () => void uninstall(app) },
      });
    } finally {
      endPending(app.id);
    }
  };

  // ── derived views ───────────────────────────────────────────────────────
  const installedById = useMemo(() => (apps ? new Map(apps.manifests.map((manifest) => [manifest.id, manifest])) : null), [apps]);

  // 云端那口对这一个 id 要说的话,三选一(#5410);yanked/deprecated 比「有新版」急,
  // 与 installedGroupOf 的优先级一致。
  const updateFlagOf = (extensionId: string): InstalledUpdateFlag => {
    if (!updates) return null;
    if (updates.yanked[extensionId]) return 'yanked';
    if (updates.deprecated[extensionId]) return 'deprecated';
    if (updates.updates[extensionId]) return 'update';
    return null;
  };
  const noticeOf = (manifest: ExtensionManifest): InstalledRowNotice | undefined => {
    if (!updates) return undefined;
    const yanked = updates.yanked[manifest.id];
    if (yanked) return { kind: 'yanked', reason: yanked.reason, installable: yanked.installable };
    const deprecated = updates.deprecated[manifest.id];
    if (deprecated) {
      return { kind: 'deprecated', note: deprecated.note, replacedBy: deprecated.replacedBy };
    }
    const behind = updates.forkBehind?.[manifest.id];
    if (behind) return { kind: 'forkBehind', ...behind };
    const update = updates.updates[manifest.id];
    if (update) return { kind: 'update', version: update.version, releaseNotes: update.releaseNotes };
    // No longer in the market: said on its row, not counted as something to do (there is nothing to do).
    if (updates.gone?.includes(manifest.id)) return { kind: 'gone' };
    return undefined;
  };

  /**
   * 这一个 App 此刻那颗按钮(一个按钮走完一生):没装 = 安装(装不了就说为什么);装着停用了 = 启用;
   * 有能装的新版 = 更新;能打开 = 打开;都不是 = 只说「已安装」。`item` 是它在市场上的那一版(没有就只看装着的)。
   */
  const lifecycleOf = (extensionId: string, item?: Pick<ShelfItem, 'manifest' | 'cloud'>): AppLifecycle => {
    // ❌ 「安装」 for an App that may be installed.
    if (!apps || !installedById) return null;
    const installed = installedById.get(extensionId);
    const fork = apps.origins[extensionId] === 'fork';
    return appLifecycle({
      installed,
      enabled: installed ? apps.isEnabled(installed.id) : false,
      updateVersion: fork ? undefined : updates?.updates[extensionId]?.version,
      offered: fork ? undefined : item,
      preinstalled: apps.isPreinstalled(extensionId),
      canOpen: installed ? onRail(installed) : false,
    }, translate);
  };

  const runLifecycle = (extensionId: string, item?: Pick<ShelfItem, 'manifest' | 'cloud' | 'ref'>) => {
    const state = lifecycleOf(extensionId, item);
    const installed = installedById?.get(extensionId);
    if (!state) return;
    if (state.kind === 'get' && item) void installFromShelf(item.ref, extensionId);
    // 更新:没新增权限直接换(按「更新」本身就是同意,spec「装与卸」);新增了的照旧问那几项。
    else if (state.kind === 'update') void installFromShelf({ extensionId, version: state.version }, extensionId);
    else if (state.kind === 'enable' && installed) void switchExtension(installed, true);
    else if (state.kind === 'open') {
      setDetail(null);
      openApp(extensionId);
    }
  };


  /** 「对 agent 说」点一句:新建任务那一页,这句已经填在输入框里(它读新建框那一格草稿)。只在本机。 */
  const askAgent = remote
    ? undefined
    : (text: string) => {
        composerDrafts.set(NEW_SESSION_DRAFT_KEY, text);
        navigate('new-session');
      };

  const resourceOf = (extensionId: string) => ({ kind: 'app' as const, target: { kind: 'app-detail' as const, extensionId, deviceId: remote?.deviceId ?? readCachedDevices().find(device => device.is_current_device)?.device_id }, facts: updates?.forkBehind?.[extensionId] ? ['behind' as const] : [] });
  const menuOf = (manifest: ExtensionManifest) => ({
    resource: resourceOf(manifest.id),
    onSettings: () => openInstalledDetail(manifest),
    onToggleDock: dockToggle(manifest),
    onOpenInWindow: onRail(manifest)
      ? () => {
          setDetail(null);
          void openAppInWindow(manifest.id);
        }
      : undefined,
    onForward: host.local ? () => forwardExtension(manifest) : undefined,
    autoUpdate: autoUpdateOf(manifest),
    onUninstall: apps!.isPreinstalled(manifest.id) ? undefined : () => confirmUninstall(manifest),
  });
  // 「自动更新」(owner 10-19):市场装的才有。这台机器(或资源库里那一台)的主进程记着;打开回来,它当场更新一遍。
  const autoUpdateOf = (manifest: ExtensionManifest) => {
    const on = apps!.autoUpdates(manifest.id);
    if (on === null) return undefined;
    return {
      on,
      onToggle: (next: boolean) =>
        void setAutoUpdate(host.key, manifest.id, next).catch((error: unknown) => {
          log.error('auto-update switch refused:', error);
          toast({ title: translateRef.current('extensions.switchFailed'), description: messageForUser(error), tier: 'error' });
        }),
    };
  };
  const toggleOf = (manifest: ExtensionManifest) =>
    apps!.isPreinstalled(manifest.id) ? undefined : (enabled: boolean) => void switchExtension(manifest, enabled);

  const installedRows = (apps ? apps.manifests : [])
    .filter((manifest) => matchesExtensionQuery(manifest, query))
    .sort((a, b) => a.name.localeCompare(b.name));
  const assistant = installedRows.find((manifest) => manifest.id === ASSISTANT_APP_ID);
  const extensionRows = installedRows.filter((manifest) => manifest.id !== ASSISTANT_APP_ID);
  const extensionPriority = (manifest: ExtensionManifest) =>
    INSTALLED_GROUP_ORDER.indexOf(installedGroupOf(apps!.isEnabled(manifest.id), updateFlagOf(manifest.id)));
  extensionRows.sort((a, b) => extensionPriority(a) - extensionPriority(b));
  const agentCount = installedAgents.rows.length + Number(assistant !== undefined);
  const invalid = apps ? apps.invalid : [];
  const invalidRows =
    query.trim() === ''
      ? invalid
      : invalid.filter((entry) =>
          entry.dirName.toLowerCase().includes(query.trim().toLowerCase())
        );

  const extensionCount = extensionRows.length + invalidRows.length;
  const installedCount = agentCount + extensionCount;
  const extensionShelf: ShelfState = shelf.status === 'ready' && shelf.query !== debouncedQuery
    ? { status: 'loading' }
    : shelf;
  const marketRows = shelf.status === 'ready' ? shelf.items : [];
  const assistantMarketItem = marketRows.find((item) => item.manifest.id === ASSISTANT_APP_ID);

  const rememberListScroll = () => {
    listScroll.current = scroller()?.scrollTop ?? 0;
  };
  const openInstalledDetail = (manifest: ExtensionManifest) => {
    rememberListScroll();
    setJustInstalled(null);
    setDetail({ page: 'manage', extensionId: manifest.id });
  };
  const openMarketAgentDetail = (agentId: string) => {
    if (host.local) setMarketDetail({ agentId });
    else (onOpenAgentDetail ?? setAgentDetailId)(agentId);
  };
  const openShelfDetail = (item: ShelfItem) => {
    if (host.local) {
      setMarketDetail({ item });
      return;
    }
    rememberListScroll();
    setJustInstalled(null);
    setDetail({ page: 'market', subject: { manifest: item.manifest, installRef: item.ref, cloud: item.cloud } });
  };
  useAppDetailRequest({ target: detailLink, ready: installed.state === 'value', host, setDetail, detail, rootRef });
  // 产品页右栏「类似 App」点一个:换到它的产品页。❌ 记清单的滚动位置 —— 此刻滚的是产品页,回清单要回到进产品页之前那里。
  const openSimilar = (item: ShelfItem) => {
    setJustInstalled(null);
    setDetail((current) => ({ page: 'market', subject: { manifest: item.manifest, installRef: item.ref, cloud: item.cloud }, from: current?.from }));
  };
  /** 市场里同一类的别的 App(取到的那几页里有的),最多五个。 */
  const similarOf = (manifest: ExtensionManifest) => {
    const category = marketCategoryOf(manifest);
    return marketRows
      .filter((item) => item.manifest.id !== manifest.id && item.manifest.id !== ASSISTANT_APP_ID
        && marketCategoryOf(item.manifest) === category && !item.cloud.deprecated)
      .slice(0, 5)
      .map((item) => {
        const text = localizedManifestText(item.manifest, locale);
        return {
          id: item.manifest.id,
          name: text.name,
          publisher: translate('extensions.official'),
          line: localizedManifestText(item.manifest, locale).subtitle,
          iconUrl: item.cloud.iconUrl,
          onOpen: () => openSimilar(item),
        };
      });
  };
  /** 设置页上的「在市场查看」:问一次市场上的那一版,返回回到设置页。 */
  const viewInMarket = (manifest: ExtensionManifest, from: AppDetail) =>
    withShelfItem(manifest.id, localizedManifestText(manifest, locale).name, (item) =>
      setDetail({ page: 'market', subject: { manifest: item.manifest, installRef: item.ref, cloud: item.cloud }, from }));
  const setTabHidden = async (manifest: ExtensionManifest, name: string, hidden: boolean) => {
    try {
      const result = await api.setTabHidden({ extensionId: manifest.id, tab: name, hidden });
      if (!result.success || !result.data) throw new Error(result.error ?? '');
      const hiddenTabs = result.data;
      putInstalled(host.key, (list) => ({ ...list, hiddenTabs }));
    } catch (error) {
      log.error('hidden tab refused:', error);
      toast({ title: translate('extensions.tabHiddenFailed'), description: messageForUser(error), tier: 'error' });
    }
  };
  const clearData = (manifest: ExtensionManifest) => {
    const name = localizedManifestText(manifest, locale).name;
    showConfirm({
      title: translate('extensions.manageDataConfirmTitle', { name }),
      description: translate('extensions.manageDataConfirmDescription', { name }),
      confirmLabel: translate('extensions.manageDataClear'),
      variant: 'destructive',
      onSuccess: () => void (async () => {
        try {
          // 它开着的页先收掉,主进程再清:清的时候不能还有页在写。
          if (host.local) await quitApp(manifest.id);
          const result = await api.clearAppData({ extensionId: manifest.id });
          if (!result.success) throw new Error(result.error ?? '');
          void extensionDataBytes.refresh(host.key, manifest.id);
          toast({ title: translate('extensions.manageDataCleared', { name }), tier: 'success' });
        } catch (error) {
          log.error('App data not cleared:', error);
          toast({ title: translate('extensions.manageDataClearFailed'), description: messageForUser(error), tier: 'error' });
        }
      })(),
    });
  };
  /** 「已停止维护 · 改用 X」按钮:回市场,把搜索框填成那个替代扩展的 id。 */
  const browseReplacement = (replacementId: string) => {
    setDetail(null);
    setTab('market');
    setQuery(replacementId);
  };

  const searchPlaceholder = translate(tab === 'agents' ? 'extensions.searchAgents'
    : tab === 'connectors' ? 'extensions.searchConnectors' : 'extensions.searchExtensions');
  const pendingPermissionsOf = (extensionId: string) =>
    Object.keys(pendingPermissions)
      .filter((key) => key.startsWith(`${extensionId}\u0000`))
      .map((key) => key.slice(extensionId.length + 1));

  /** 已安装那一行名字下面那一句:有新版 / 撤回、停维(带下一步)/ 程序没起来 / 收回了几项 / 简介。 */
  const installedLine = (manifest: ExtensionManifest): ReactNode => {
    const notice = noticeOf(manifest);
    if (notice?.kind === 'update') return <span>{translate('extensions.rowHasUpdate', { version: notice.version })}</span>;
    if (notice) {
      return (
        // 句子里的链接词是它自己的事,❌ 顺带开产品页;点句子别处照常开。
        <span onClick={(event) => (event.target as HTMLElement).closest('button') && event.stopPropagation()}>
          <InstalledRowNoticeLine
            notice={notice}
            installedVersion={manifest.version}
            translate={translate}
            onInstallVersion={(version) => void installFromShelf({ extensionId: manifest.id, version }, manifest.id)}
            onBrowseReplacement={() => notice.kind === 'deprecated' && notice.replacedBy && browseReplacement(notice.replacedBy)}
          />
        </span>
      );
    }
    // What its program and its permissions say is not known yet: the line waits for them (❌ the subtitle, then a warning).
    if (!agentStatus || !revoked) return <Unknown className="w-40" />;
    const failure = agentStatus[manifest.id]?.lastFailure;
    if (failure) {
      // 程序在 stderr 上的原话可能是一整段栈,不进文案(仓规 copy-leaks-internal-detail),放在悬停里给要追的人看。
      return (
        <span className="is-warn" title={failure.stderrTail || undefined}>
          {programFailureText(failure, translate)}
        </span>
      );
    }
    const declared = declaredPermissions(manifest);
    const withdrawn = declared.filter((permission) => takenBack(revoked, manifest.id).includes(permission.key)).length;
    if (withdrawn > 0) return <span>{translate('extensions.rowRevoked', { count: withdrawn })}</span>;
    const text = localizedManifestText(manifest, locale);
    return <span>{text.subtitle}</span>;
  };

  const renderInstalledApp = (manifest: ExtensionManifest) => (
    <InstalledAppRow
      key={manifest.id}
      id={manifest.id}
      name={`${localizedManifestText(manifest, locale).name}${apps!.variants[manifest.id]?.active && apps!.variants[manifest.id]!.active !== 'upstream' ? ` ${apps!.variants[manifest.id]!.active}` : ''}`}
      version={manifest.version}
      line={installedLine(manifest)}
      iconUrl={apps!.appIcons[manifest.id]}
      enabled={apps!.isEnabled(manifest.id)}
      switching={switching[manifest.id] === true}
      lifecycle={lifecycleOf(manifest.id)}
      pending={pending[manifest.id]}
      pendingPercent={downloadPercent[manifest.id]}
      docked={apps!.dock.includes(manifest.id)}
      translate={translate}
      onOpen={() => openInstalledDetail(manifest)}
      onAction={() => runLifecycle(manifest.id)}
      onToggleEnabled={toggleOf(manifest)}
      menu={menuOf(manifest)}
    />
  );

  if (renderInstalledApps) {
    const items: InstalledItem[] = installedRows.map((manifest) => {
      const name = localizedManifestText(manifest, locale).name;
      const state = lifecycleOf(manifest.id);
      const currentVersion = manifest.version;
      const icon = apps!.appIcons[manifest.id];
      return {
        id: manifest.id,
        name,
        version: currentVersion,
        icon: (size) => icon
          ? <img aria-hidden="true" alt="" src={icon} width={size} height={size} />
          : <AppIcon id={manifest.id} size={size} />,
        open: onOpenInstalledApp ? () => onOpenInstalledApp(manifest.id) : undefined,
        busy: !!pending[manifest.id] || !!switching[manifest.id],
        enabled: apps!.isEnabled(manifest.id),
        setEnabled: apps!.isPreinstalled(manifest.id) ? undefined : (next) => switchExtension(manifest, next),
        update: state?.kind === 'update' ? async () => {
          await installFromShelf({ extensionId: manifest.id, version: state.version }, manifest.id, { singleMachine: true });
          if (peekInstalledApps(host.key)?.manifests.find((entry) => entry.id === manifest.id)?.version !== state.version) {
            throw new Error('The app update did not complete');
          }
        } : undefined,
        remove: apps!.isPreinstalled(manifest.id) ? undefined : async () => {
          await uninstall(manifest);
          if (peekInstalledApps(host.key)?.manifests.some((entry) => entry.id === manifest.id)) throw new Error('The app was not removed');
        },
      };
    });
    // Not read yet: no rows, and the page says it is loading (`loading` below).
    if (apps) for (const entry of apps.invalid) {
      const id = entry.dirName;
      items.push({
        id,
        name: id,
        icon: () => <ExtensionMonogram name={id} broken />,
        busy: !!pending[id],
        remove: async () => {
          await uninstall({ id, name: id });
          if (peekInstalledApps(host.key)?.invalid.some((row) => row.dirName === id)) throw new Error('The app was not removed');
        },
      });
    }
    return renderInstalledApps(items, { loading: installed.state === 'unknown', error: installed.state === 'error' });
  }

  const header = (aside?: ReactNode) => (
    <PageHeader sticky title={translate('extensions.tabMarket')} aside={aside} />
  );

  // 别的机器此刻给不出清单、手上也没有上次的:只说那一句。页头照画 —— 换机器的选择器在页头上,❌ 让人困在这一句里。
  if (notice && installed.state !== 'value') {
    return (
      <div className="mk" data-testid="extensions-store" ref={rootRef}>
        {header(detailLink && (
          <Button variant="ghost" size="sm" onClick={onCloseDetailLink}>{translate('common.back')}</Button>
        ))}
        <DeviceScopeNoticeLine notice={notice} onRetry={() => void refresh()} />
      </div>
    );
  }

  // ── 市场页:就在这一栏里铺开,左上「‹ App」回到清单 ──
  if (detail?.page === 'market') {
    // The catalog read again while this page is open (a new version listed): the page says the newer one, as the list does.
    const listed = marketRows.find((row) => row.manifest.id === detail.subject.manifest.id);
    const subject = listed ? { manifest: listed.manifest, cloud: listed.cloud, installRef: listed.ref } : detail.subject;
    const { manifest } = subject;
    const installedHere = installedById?.get(manifest.id);
    const item = { manifest, cloud: subject.cloud, ref: subject.installRef };
    return (
      <div className="mk" data-testid="extensions-product" ref={rootRef}>
        {notice && <DeviceScopeNoticeLine notice={notice} onRetry={() => void refresh()} noHeading />}
        <div className="pt-10 pb-14">
          <AppProductPage
            // 点「类似 App」是换一个 App:整页重来,❌ 带着上一个的截图、展开的版本历史画一帧。
            key={manifest.id}
            subject={{ ...subject, installedVersion: installedHere?.version }}
            iconDataUrl={installedHere ? apps!.appIcons[installedHere.id] : undefined}
            lifecycle={lifecycleOf(manifest.id, item)}
            pending={pending[manifest.id]}
            pendingPercent={downloadPercent[manifest.id]}
            locale={locale}
            translate={translate}
            machine={remote?.deviceLabel}
            hostKey={host.key}
            readOnly={!!notice?.readOnly}
            justInstalled={justInstalled === manifest.id && Boolean(installedHere)}
            backLabel={detail.from ? translate('extensions.appSettings') : undefined}
            onBack={() => {
              if (!detail.from) onCloseDetailLink?.();
              setDetail(detail.from ?? null);
              setJustInstalled(null);
            }}
            onLifecycle={() => runLifecycle(manifest.id, item)}
            onInstallVersion={(ref) => void installFromShelf(ref, manifest.id)}
            onManage={installedHere ? () => setDetail({ page: 'manage', extensionId: manifest.id, from: detail }) : undefined}
            onForward={installedHere && host.local ? () => forwardExtension(installedHere) : undefined}
            onAsk={askAgent}
            similar={similarOf(manifest)}
            resource={resourceOf(manifest.id)}
          />
        </div>
      </div>
    );
  }

  // ── App 设置页:只管装着的这一份。别处把它卸了就回清单 ──
  const managed = detail?.page === 'manage' ? installedById?.get(detail.extensionId) : undefined;
  // ❌ every switch drawn on (AP2).
  if (detail?.page === 'manage' && managed && apps && !revoked) {
    return (
      <div className="mk" data-testid="extensions-manage" ref={rootRef}>
        {revokedReading.state === 'error' ? (
          <div className="mk-status" role="alert">
            <CircleAlert className="size-4 shrink-0" />
            <span className="min-w-0">{translate('extensions.loadFailed')}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>{translate('extensions.retry')}</Button>
          </div>
        ) : <InstalledRowsSkeleton label={translate('extensions.loading')} />}
      </div>
    );
  }
  if (detail?.page === 'manage' && managed && apps && revoked) {
    const origin = apps.origins[managed.id];
    // 「在市场查看」 and the versions: a market App not said to be gone (the market's word not known yet: not gone).
    const inMarket = (origin === 'market' || origin === 'fork') && !updates?.gone?.includes(managed.id);
    const enabled = apps.isEnabled(managed.id);
    const menu = menuOf(managed);
    // One gugu ships is where gugu puts it, and other Apps and every task lean on it: this page shows it and manages nothing that could break it.
    const builtIn = apps.isPreinstalled(managed.id);
    const hiddenTabs = apps.hiddenTabsOf(managed.id);
    return (
      <div className="mk" data-testid="extensions-manage" ref={rootRef}>
        {notice && <DeviceScopeNoticeLine notice={notice} onRetry={() => void refresh()} />}
        <AppManagePage
          key={managed.id}
          manifest={managed}
          iconDataUrl={apps.appIcons[managed.id]}
          enabled={enabled}
          switching={switching[managed.id] === true}
          lifecycle={appLifecycle({ installed: managed, enabled, preinstalled: apps.isPreinstalled(managed.id), canOpen: onRail(managed) }, translate)}
          pending={pending[managed.id]}
          pendingPercent={downloadPercent[managed.id]}
          locale={locale}
          translate={translate}
          machine={remote?.deviceLabel}
          api={api}
          readOnly={!!notice?.readOnly}
          backLabel={detail.fromApp ? localizedManifestText(managed, locale).name : translate(detail.from ? 'extensions.title' : 'extensions.tabInstalled')}
          notice={noticeOf(managed)}
          origin={origin}
          variants={apps.variants[managed.id]}
          revoked={takenBack(revoked, managed.id)}
          hostKey={host.key}
          pendingPermissions={pendingPermissionsOf(managed.id)}
          agentStatus={agentStatus?.[managed.id]}
          permissionsNote={builtIn ? translate('extensions.permissionsNoteBuiltIn') : undefined}
          disclosure={builtIn ? undefined : apps.disclosure[managed.id]}
          givenApi={builtIn ? undefined : api}
          docked={apps.dock.includes(managed.id)}
          hiddenTabs={hiddenTabs}
          prompts={enabled && managed.contributes.prompts?.length ? <AppPromptsSection extensionId={managed.id} store={apps} /> : undefined}
          settingsApi={{ save: (settings) => api.setSettings({ extensionId: managed.id, settings }) }}
          autoUpdate={inMarket ? menu.autoUpdate : undefined}
          resource={menu.resource}
          onBack={() => {
            if (!detail.from) onCloseDetailLink?.();
            if (detail.fromApp) {
              setDetail(null);
              openApp(managed.id);
              return;
            }
            if (!detail.from) { if (openInstalled) openInstalled(); else setTab('installed'); }
            setDetail(detail.from ?? null);
          }}
          onLifecycle={() => runLifecycle(managed.id)}
          onInstallVersion={inMarket ? (ref) => void installFromShelf(ref, managed.id) : undefined}
          onSwitchVariant={(name) => void switchVariant(managed, name)}
          onToggleEnabled={toggleOf(managed)}
          onToggleDock={menu.onToggleDock}
          onOpenInWindow={menu.onOpenInWindow}
          onForward={menu.onForward}
          onSetTabHidden={builtIn ? undefined : (name, hidden) => void setTabHidden(managed, name, hidden)}
          onOpenTab={remote ? undefined : (name) => { openApp(managed.id, name); }}
          onTogglePermission={builtIn ? undefined : (permission, granted) => void setPermissionGranted(managed, permission, granted)}
          onDisclosureChange={(level) => void setDisclosure(managed, level)}
          onBrowseReplacement={browseReplacement}
          onClearData={builtIn ? undefined : () => clearData(managed)}
          onViewInMarket={inMarket ? () => void viewInMarket(managed, detail) : undefined}
          onOpenExternal={confirmOpenExternalLink}
          onUninstall={menu.onUninstall}
        />
      </div>
    );
  }

  const marketItem = marketDetail && 'item' in marketDetail
    ? marketRows.find(({ manifest }) => manifest.id === marketDetail.item.manifest.id) ?? marketDetail.item
    : null;
  const marketInstalled = marketItem && installedById?.get(marketItem.manifest.id);
  const marketAction = marketItem && lifecycleOf(marketItem.manifest.id, marketItem);

  const search = (
    <SearchInput
      ref={searchRef}
      type="search"
      containerClassName="w-[180px] min-w-0 [@container(max-width:600px)]:w-32"
      placeholder={searchPlaceholder}
      aria-label={searchPlaceholder}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  );

  return (
    <div className="mk" data-testid="extensions-store" ref={rootRef}>
      {notice && <DeviceScopeNoticeLine notice={notice} onRetry={() => void refresh()} />}
      <fieldset disabled={!!notice?.readOnly} className="contents">
        <div className="mk-bar mk-market-header">
          <ToggleGroup
            className="gap-6 overflow-visible border-none bg-transparent"
            aria-label={translate('extensions.tabMarket')}
            value={tab === 'installed' ? [] : [tab]}
            onValueChange={([value]) => {
              if (value === 'agents' || value === 'market' || value === 'connectors') {
                if (detailLink) onCloseDetailLink?.();
                setTab(value);
                onMarketPageChange?.(value);
              }
            }}
          >
            <ToggleGroupItem value="agents" data-testid="extensions-section-agents">
              <SquareTerminal className="size-4" aria-hidden />
              {translate('extensions.tabAgents')}
            </ToggleGroupItem>
            <ToggleGroupItem value="market" data-testid="extensions-section-market">
              <LayoutGrid className="size-4" aria-hidden />
              {translate('extensions.tabExtensions')}
            </ToggleGroupItem>
            <ToggleGroupItem value="connectors" data-testid="extensions-section-connectors">
              <Plug className="size-4" aria-hidden />
              {translate('extensions.tabConnectors')}
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="mk-market-actions">
            {search}
            <Button type="button" variant="outline" size="sm" data-testid={openInstalled ? 'extensions-open-installed' : 'extensions-tab-installed'}
              onClick={openInstalled ?? (() => setTab('installed'))}>
              <Archive className="size-4" aria-hidden />
              {translate('extensions.tabInstalled')}
              {apps && updates && updateCountOf(updates, apps) > 0 ? <span className="mk-seg-dot" aria-hidden /> : null}
            </Button>
            {tab === 'connectors' && <AddConnectorButton />}
          </div>
        </div>

        {tab === 'connectors' && <ConnectorMarketPage query={query} />}

        {tab === 'agents' && (
          <div className="pb-14" data-testid="agent-market-panel">
            {machineOffline ? (
              <div className="mk-status" role="status">{translate('extensions.marketOfflineUnreachable')}</div>
            ) : (
              <AgentMarketContent
                query={query}
                category={agentCategory}
                onCategoryChange={setAgentCategory}
                onOpenAgentDetail={openMarketAgentDetail}
                assistant={assistantMarketItem}
                assistantInstalled={installedById ? installedById.has(ASSISTANT_APP_ID) : undefined}
                assistantLoading={shelf.status === 'loading'}
                onOpenAssistant={() => assistantMarketItem && openShelfDetail(assistantMarketItem)}
                assistantResource={resourceOf(ASSISTANT_APP_ID)}
              />
            )}
          </div>
        )}

        {tab === 'market' && (
          <div className="pb-14" data-testid="extensions-market-panel">
            {/* 那台机器此刻连不上:清单问不了(问了只会挂满超时),照实说,❌ 一直转骨架。 */}
            {/* 那台机器连不上时只有这一句:下面读清单的几种结果(转圈、出错、连不上下载站)都不画,❌ 两条「连不上」叠在一起。 */}
            {machineOffline ? (
              <div className="mk-status" role="status" data-testid="extension-market-offline">
                <span>{translate('extensions.marketOfflineUnreachable')}</span>
              </div>
            ) : null}
            {!machineOffline && extensionShelf.status === 'loading' ? (
              <div className="mk-sec">
                <ShelfSkeleton label={translate('extensions.loading')} />
              </div>
            ) : null}

            {!machineOffline && (extensionShelf.status === 'error' || shownFailure) && (
              <div className="mk-status" role="alert">
                <CircleAlert className="size-4 shrink-0" />
                <span className="min-w-0">{translate('extensions.marketUnavailable')}</span>
                <Button type="button" variant="ghost" size="sm" onClick={retryShelf}>
                  {translate('extensions.retry')}
                </Button>
              </div>
            )}

            {!machineOffline &&
              extensionShelf.status === 'ready' &&
              (extensionShelf.errorKind ? (
                // 连不上下载站:只说这一句和「重试」—— 市场只有这一个来源,已装的 App 照常能用(App 市场方案 10-07);
                // ❌ 再画「这里还没有 App」:读不到清单和清单是空的是两件事。
                <div className="mk-status" role="status" data-testid="extension-market-offline">
                  <span>{translate('extensions.marketOfflineUnreachable')}</span>
                  <Button type="button" variant="ghost" size="sm" onClick={retryShelf}>
                    {translate('extensions.retry')}
                  </Button>
                </div>
              ) : (
                <DesktopExtensionMarket
                  shelf={extensionShelf}
                  query={extensionShelf.query}
                  category={chip}
                  onCategoryChange={setChip}
                  installedIds={installedById ? new Set(installedById.keys()) : undefined}
                  onOpen={openShelfDetail}
                  resourceOf={resourceOf}
                  sentinelRef={sentinelRef}
                  stale={marketStale ? translate('extensions.marketStale', { time: marketStaleTime(marketStale, locale) }) : null}
                />
              ))}
          </div>
        )}

        {tab === 'installed' && (
          <div className="pb-14" data-testid="extensions-installed-panel">
            {inventoryError !== null && !notice && (
              <div className="mk-status" role="alert">
                <CircleAlert className="size-4 shrink-0" />
                <span className="min-w-0">{translate('extensions.loadFailed')}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
                  {translate('extensions.retry')}
                </Button>
              </div>
            )}
            {/* Which Apps have a new version (the rows' update marks, the tab's dot) could not be read again: said with a retry. */}
            {!machineOffline ? <RefreshFailed reading={updatesReading} /> : null}

            {(installed.state === 'unknown' || installedAgents.inventory.reading.state === 'unknown') && installedCount === 0 && (
              <div className="mk-sec">
                <InstalledRowsSkeleton label={translate('extensions.loading')} />
              </div>
            )}

            {installedAgents.inventory.reading.state === 'error' && !notice && (
              <div className="mk-status" role="alert">
                <CircleAlert className="size-4 shrink-0" />
                <span className="min-w-0">{translate('extensions.agentInventoryFailed')}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void installedAgents.inventory.refetch()}>
                  {translate('extensions.retry')}
                </Button>
              </div>
            )}

            {agentCount > 0 && (
              <section className="mk-sec" data-testid="installed-apps-agents">
                <h3>
                  {translate('settings.agents')}
                  <span className="mk-count">{agentCount}</span>
                </h3>
                <ul className="mk-list">
                  {assistant && renderInstalledApp(assistant)}
                  <InstalledAgentRows
                    inventory={installedAgents}
                    onOpenAgentDetail={onOpenAgentDetail ?? setAgentDetailId}
                    readOnly={!!notice?.readOnly}
                  />
                </ul>
              </section>
            )}

            {extensionCount > 0 && (
              <section className="mk-sec" data-testid="installed-apps-extensions">
                <h3>
                  {translate('extensions.installedExtensions')}
                  <span className="mk-count">{extensionCount}</span>
                </h3>
                <ul className="mk-list">
                  {invalidRows.map((entry) => (
                    <li
                      key={entry.dirName}
                      className="mk-row"
                      data-testid="extension-row-unreadable"
                      data-extension-dir={entry.dirName}
                    >
                      <span className="mk-icon">
                        <ExtensionMonogram name={entry.dirName} broken />
                      </span>
                      <div className="mk-tx">
                        <b>
                          <span className="mk-name">{entry.dirName}</span>
                          <em>{translate('extensions.unreadableShort')}</em>
                        </b>
                        <span className="xp-row-error" title={entry.reason}>
                          {translate('extensions.unreadable', { name: entry.dirName, reason: entry.reason })}
                        </span>
                      </div>
                      {/* Unreadable is still installed: removable here, as every other row is (L11 复核 60). */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="hover:text-foreground-destructive"
                        data-testid="extension-row-unreadable-uninstall"
                        aria-label={translate('extensions.uninstallAction')}
                        title={translate('extensions.uninstallAction')}
                        onClick={() => confirmUninstall({ id: entry.dirName, name: entry.dirName })}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </li>
                  ))}
                  {extensionRows.map(renderInstalledApp)}
                </ul>
              </section>
            )}
            {apps && installedAgents.inventory.reading.state === 'value' && installedCount === 0 && (
              <div className="mk-empty">
                {query.trim() === '' ? translate('extensions.empty') : translate('extensions.noMatch', { query: query.trim() })}
                {query.trim() === '' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setTab('market')}>
                    {translate('extensions.browseMarket')}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </fieldset>
      {shown && marketDetail && (
        <MarketDetailDialog onClose={closeMarketDetail}>
          {'agentId' in marketDetail ? (
            <MarketAgentDetail agentId={marketDetail.agentId} onCreate={() => {
              closeMarketDetail();
              navigate('new-session', { agentId: marketDetail.agentId });
            }} />
          ) : marketItem && (
            <MarketExtensionDetail
              item={marketItem}
              installedVersion={marketInstalled?.version}
              icon={apps?.appIcons[marketItem.manifest.id]}
              lifecycle={marketAction}
              pending={pending[marketItem.manifest.id]}
              pendingPercent={downloadPercent[marketItem.manifest.id]}
              // What is installed unread (its read failed, the shelf read): no version is changed from here.
              canChangeVersion={apps ? !apps.isPreinstalled(marketItem.manifest.id) : false}
              onInstall={(ref, confirm) => void installFromShelf(ref, marketItem.manifest.id, { confirm })}
              onLifecycle={() => {
                if (marketAction?.kind === 'open') closeMarketDetail();
                runLifecycle(marketItem.manifest.id, marketItem);
              }}
              onUninstall={marketInstalled && apps && !apps.isPreinstalled(marketInstalled.id)
                ? () => void uninstall({ id: marketInstalled.id, name: localizedManifestText(marketInstalled, locale).name })
                : undefined}
            />
          )}
        </MarketDetailDialog>
      )}
      {agentDetailId && <AgentDetailModal agentId={agentDetailId} onClose={() => setAgentDetailId(null)} />}
    </div>
  );
});
