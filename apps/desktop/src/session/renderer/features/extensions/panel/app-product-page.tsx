import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Bell,
  Check,
  ChevronLeft,
  ExternalLink,
  Eye,
  Globe,
  LayoutGrid,
  Lock,
  MessageCircle,
  Moon,
  Pencil,
  Share2,
  ShieldCheck,
  Terminal,
  Users,
  Wrench,
} from '@/lib/icons';
import './extensions-panel.css';
import './app-store.css';
import { Button } from '@renderer/lib/ui/button';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import { ExpandableImage } from '@renderer/lib/ui/expandable-image';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { rpc } from '@renderer/lib/ipc';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import { givesAgentTools } from '@shared/extensions/app-places';
import {
  declaredPermissions,
  localizedManifestText,
  localizedTabText,
  manifestLanguages,
  marketCategoryOf,
  permissionSide,
  type DeclaredPermission,
} from '@shared/extensions/catalog';
import { claimedSuffixes, type ExtensionCapability, type ExtensionManifest } from '@shared/extensions/manifest';
import type { MarketListing } from '@shared/extensions/market-entries';
import {
  marketSourceLabel,
  marketSourceUrl,
  type CloudMarketEntryMeta,
  type MarketSourceRef,
  marketCompatText,
} from '@shared/extensions/market';
import { describeCapability, programDetails, type SessionTranslate } from '../extension-consent';
import type { ExtensionsApi } from '../extensions-host';
import { AppLifecycleButton, type AppLifecycle } from './app-lifecycle-button';
import { ResourceMenu } from '@/components/ResourceMenu';
import type { ResourceContext } from '@shared/resource-actions';
import { AppShelfRow } from './app-shelf';
import { VersionHistorySection, shortDate, type Loadable } from './app-version-history';
import type { MarketVersionHistoryEntry } from '@shared/extensions/market';
import { ExtensionMonogram } from './extension-monogram';
import type { ExtensionPendingAction } from './extension-pending';

/**
 * The market's page of an App: the version the market offers, whatever is installed. `installedVersion` only says what the
 * button does and that another version is here; everything else about the installed copy is its settings page's
 * (app-manage-page.tsx). Refs #5265, #5410.
 */
export interface ExtensionDetailSubject {
  manifest: ExtensionManifest;
  installRef: MarketSourceRef;
  cloud: CloudMarketEntryMeta;
  installedVersion?: string;
}

export type ProductPageApi = Pick<typeof rpc.extensions, 'marketListing' | 'marketHistory'> & Partial<Pick<ExtensionsApi, 'marketRead'>>;

/**
 * 一个 App 的市场页(#7059):在「App」那一栏里整页铺开,左上「‹ App」回到清单。只回答「要不要装」,所以页上没有开关;管装着的那一份在
 * App 设置页(app-manage-page.tsx)。版面照 Google Play 的应用页(owner 10-10「这个是我想要的」):头上大字名字、副标题、发布方、一排
 * 要点、大按钮,右边大图标;下面左栏截图轮播 → 关于 → 新功能和版本历史 → 它带来了什么 → 权限(它能看 / 它能做)→ 信息;右栏审核那张
 * 卡、链接、类似 App。名字、副标题、关于、示例句跟界面语言走;它还写了别的语言,「关于」旁边给一个切换。
 */
export function AppProductPage({
  subject,
  iconDataUrl,
  lifecycle,
  pending,
  pendingPercent,
  locale,
  translate,
  machine,
  api = rpc.extensions,
  readOnly = false,
  justInstalled = false,
  backLabel,
  onBack,
  onLifecycle,
  onInstallVersion,
  onManage,
  onForward,
  onAsk,
  onOpenExternal = confirmOpenExternalLink,
  backgroundSupported = true,
  phoneAgentCapabilities = [],
  similar = [],
  resource,
}: {
  subject: ExtensionDetailSubject;
  /** The installed copy's icon as main re-encoded it, drawn when the market has none. */
  iconDataUrl?: string;
  lifecycle: AppLifecycle;
  pending?: ExtensionPendingAction;
  pendingPercent?: number;
  locale: string;
  translate: SessionTranslate;
  /** 看的是另一台机器的 App 时,那台的名字:权限那一张卡如实写它,❌ 写「这台电脑」。不给 = 本机。 */
  machine?: string;
  /** 产品页内容、版本历史、工具清单问哪台机器(#6264)。不给 = 本机。 */
  api?: ProductPageApi;
  /** 那台机器此刻做不了事(离线 / server 太旧,#6264):照旧看,动作全灰。 */
  readOnly?: boolean;
  /** 刚在这一页装好:头下面一句「装好了」和去哪找它。 */
  justInstalled?: boolean;
  /** Where back goes, when not the market: the App's settings page. */
  backLabel?: string;
  onBack: () => void;
  onLifecycle: () => void;
  onInstallVersion: (ref: MarketSourceRef) => void;
  /** Installed only: its settings page, where everything about this copy is managed. */
  onManage?: () => void;
  onForward?: () => void;
  /** 「对 agent 说」点一句 = 新建任务、这句已填好;不给(看的是别的机器)就只读。 */
  onAsk?: (text: string) => void;
  /** Opens a web link on the viewing device. Desktop retains its confirmation dialog. */
  onOpenExternal?: (url: string) => void;
  /** The phone has no persistent App background-page host. */
  backgroundSupported?: boolean;
  /** Agent capabilities declared by the App, before the phone removes them from its permission list. */
  phoneAgentCapabilities?: readonly ExtensionCapability[];
  /** 右栏「类似 App」:市场里同一类的别的 App(照 Google Play),点一个 = 换到它的产品页。 */
  similar?: { id: string; name: string; publisher: string; line: string; iconUrl?: string | null; onOpen: () => void }[];
  resource?: ResourceContext;
}) {
  const { manifest, cloud, installedVersion } = subject;
  // 没点过切换就跟界面语言(界面语言换了也跟着换);点过的那一格还在就用它。
  const languages = manifestLanguages(manifest, locale);
  const [picked, setPicked] = useState<string | null>(null);
  const textLocale = languages.find((option) => option.locale === picked)?.locale ?? languages[0]!.locale;
  const text = localizedManifestText(manifest, textLocale);
  const { compat, deprecated } = cloud;
  const [listing, setListing] = useState<Loadable<MarketListing> | { status: 'outdated' }>({ status: 'idle' });
  const [history, setHistory] = useState<Loadable<MarketVersionHistoryEntry[]>>({ status: 'idle' });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutClamped, setAboutClamped] = useState(false);
  const aboutRef = useRef<HTMLDivElement | null>(null);

  // 懒加载,换了 App(id / 版本变了)才取一次;卸下时取消挂起的那次,免得旧数据落进新的一页。只有市场上的版本有产品页内容
  // (`store/` 不进安装包);读不到就照实说(那台机器的咕咕太旧 / 市场上这一版没有),❌ 改读别处。
  const listedVersion = cloud.version;
  useEffect(() => {
    setAboutOpen(false);
    let cancelled = false;
    setListing({ status: 'loading' });
    void api
      .marketListing({ extensionId: manifest.id, version: listedVersion })
      .then((result) => {
        if (cancelled) return;
        if (!result.success) throw new Error(result.error);
        setListing({ status: 'ready', data: result.data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn('App market listing unreadable:', error);
        setListing({ status: (error as { code?: unknown } | null)?.code === 'server_outdated' ? 'outdated' : 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, manifest.id, listedVersion]);

  useEffect(() => {
    let cancelled = false;
    setHistory({ status: 'loading' });
    void api
      .marketHistory({ extensionId: manifest.id })
      .then((result) => {
        if (cancelled) return;
        if (!result.success || !result.data) throw new Error(result.error ?? 'history unreadable');
        setHistory({ status: 'ready', data: result.data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        log.warn('extension version history unreadable:', error);
        setHistory({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [api, manifest.id]);

  const publishedAt = cloud.publishedAt;
  const permissions = declaredPermissions(manifest);
  const shots = listing.status === 'ready' ? listing.data.screenshots : [];
  const aboutText = listing.status === 'ready' ? listing.data.about[textLocale] : undefined;
  // 折叠到四行放不下才给「展开」:量的是画出来的高度,换语言、换 App 都重量。
  useLayoutEffect(() => {
    const box = aboutRef.current;
    setAboutClamped(Boolean(box && box.scrollHeight > box.clientHeight + 1));
  }, [aboutText]);
  const publisher = translate('extensions.official');
  const category = marketCategoryOf(manifest);
  const programs = (manifest.contributes.mcpServers ?? []).map((server) => ('name' in server ? server.name : server.tools));

  // ── 截图轮播(照 Google Play:产品页头下面一排图,放不下就横着翻;不写图注)。截图是 defaultLocale 那种语言的界面:
  // 界面语言是别的,就照实说一句是哪种语言的,❌ 当成这种语言的 ──
  const shotsLanguage = screenshotsLanguage(manifest, locale);
  const screenshots =
    shots.length > 0 ? (
      <section className="mk-dsec is-shots" key="shots" data-testid="app-product-preview" data-image-gallery="">
        {shotsLanguage ? <p className="mk-note" data-testid="app-product-shots-language">{translate('extensions.screenshotsIn', { language: shotsLanguage })}</p> : null}
        <AppShelfRow label={translate('extensions.preview')} prevLabel={translate('extensions.shelfPrev')} nextLabel={translate('extensions.shelfNext')}>
          {shots.map((src, index) => (
            <figure className="mk-shot" role="listitem" key={src}>
              {/* 截图是发布时传到下载站的公开地址(sync.mjs);会话页主渲染进程没对 img-src 设 CSP。 */}
              <ExpandableImage src={src} alt={translate('extensions.screenshotOf', { name: text.name, index: index + 1 })} loading="lazy" decoding="async" />
            </figure>
          ))}
        </AppShelfRow>
      </section>
    ) : null;

  // ── 对 agent 说:点一句 = 新建任务、这句已填好(放在「它带来了什么」里)──
  const ask =
    text.examples.length > 0 ? (
      <AddsEntry key="ask" icon={<MessageCircle className="size-4" />} label={translate('extensions.askAgent')} testId="app-product-ask">
        <div className="mk-asks">
          {text.examples.map((example) => (
            <button
              type="button"
              className="mk-ask"
              key={example}
              disabled={!onAsk}
              title={translate('extensions.askAgentHint')}
              onClick={() => onAsk?.(example)}
            >
              <span>{example}</span>
              <ArrowUp className="size-3.5" />
            </button>
          ))}
        </div>
      </AddsEntry>
    ) : null;

  // ── 关于:市场上这一版的 store/about*.md,页内直接画,默认折叠到四行(照 App Store 产品页的「more」)──
  const about = (
    <section className="mk-dsec" key="about" data-testid="app-product-about">
      <div className="mk-sec-h">
        <h3>{translate('extensions.aboutApp')}</h3>
        {languages.length > 1 ? (
          <ToggleGroup
            size="sm"
            spacing={1}
            className="gap-1 overflow-visible border-none bg-transparent"
            aria-label={translate('extensions.textLanguage')}
            value={[textLocale]}
            onValueChange={([value]) => value && setPicked(value)}
            data-testid="app-product-language"
          >
            {languages.map((option) => (
              <ToggleGroupItem key={option.locale} value={option.locale} className="px-2 text-sm">
                {languageName(option.language)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </div>
      {aboutText !== undefined ? (
        <>
          <div ref={aboutRef} className={cn('mk-about', !aboutOpen && 'is-clamped')} data-testid="app-product-about-text">
            <MarkdownRenderer content={aboutText} onOpenLink={(url) => { onOpenExternal(url); return true; }} />
          </div>
          {aboutClamped || aboutOpen ? (
            <button type="button" className="mk-link" aria-expanded={aboutOpen} onClick={() => setAboutOpen((open) => !open)} data-testid="app-product-about-toggle">
              {translate(aboutOpen ? 'extensions.collapse' : 'extensions.expand')}
            </button>
          ) : null}
        </>
      ) : (
        <p className="mk-note" role={listing.status === 'idle' || listing.status === 'loading' ? undefined : 'alert'}>
          {translate(
            listing.status === 'idle' || listing.status === 'loading'
              ? 'extensions.loading'
              : listing.status === 'outdated'
                ? 'extensions.listingPeerOutdated'
                : 'extensions.listingUnavailable'
          )}
        </p>
      )}
    </section>
  );

  // ── 新功能 + 版本历史 ──
  let news: ReactNode = null;
  if (cloud.releaseNotes || (history.status === 'ready' && history.data.length > 0)) {
    const latest = history.status === 'ready' ? history.data[0] : undefined;
    const notes = cloud.releaseNotes || latest?.releaseNotes || '';
    const notesVersion = cloud.version;
    const notesDate = cloud.publishedAt;
    news = (
      <section className="mk-dsec" key="news" data-testid="app-product-news">
        <div className="mk-sec-h">
          <h3>{translate('extensions.whatsNew')}</h3>
          <button type="button" className="mk-link" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}>
            {translate(historyOpen ? 'extensions.collapse' : 'extensions.detailVersionHistory')}
          </button>
        </div>
        <div className="mk-new">
          {notes ? <MarkdownRenderer content={notes} onOpenLink={(url) => { onOpenExternal(url); return true; }} /> : null}
          <span>
            {notesDate
              ? translate('extensions.releasedOn', { version: notesVersion, date: shortDate(notesDate, locale) })
              : `v${notesVersion}`}
          </span>
        </div>
        {historyOpen ? (
          // 没装时可以挑一版装;装着的换版本在它的设置页,这里只读。那台机器做不了事时跟头上那颗一起灰。
          <fieldset disabled={readOnly} className="contents">
            <div className="mk-vers">
              <VersionHistorySection
                state={history}
                extensionId={manifest.id}
                installedVersion={installedVersion}
                offeredVersion={null}
                locale={locale}
                translate={translate}
                onOpenExternal={onOpenExternal}
                onInstallVersion={installedVersion ? undefined : (version) => onInstallVersion({ extensionId: manifest.id, version })}
              />
            </div>
          </fieldset>
        ) : null}
      </section>
    );
  }

  // ── 装上后多了什么 ──
  // 同名的几个页签(会话页一个、群里一个)是用的人眼里的同一个页签:一行,各说各的。
  const tabsByTitle = new Map<string, string[]>();
  for (const tab of manifest.contributes.tabs) {
    const text = localizedTabText(manifest, tab, locale);
    const toolbar = text.toolbar.map((command) => command.title);
    const suffixes = [...new Set([...claimedSuffixes(tab, 'session'), ...claimedSuffixes(tab, 'chat')])];
    const line = toolbar.length
      ? translate('extensions.addsTabToolbar', { commands: listOf(toolbar, locale) })
      : suffixes.length
        ? translate('extensions.addsTabOpens', { suffixes: listOf(suffixes, locale) })
        : translate('extensions.addsTabPlain');
    tabsByTitle.set(text.title, [...(tabsByTitle.get(text.title) ?? []), line]);
  }
  const adds: ReactNode[] = [...tabsByTitle].map(([title, lines]) => (
    <AddsEntry key={`tab:${title}`} icon={<LayoutGrid className="size-4" />} label={translate('extensions.addsTabTitle', { title })}>
      {[...new Set(lines)].map((line) => (
        <i key={line}>{line}</i>
      ))}
    </AddsEntry>
  ));
  // 给 agent 东西的(带程序,或只带技能说明):工具名字要问装好的程序,这里只说它带什么;给谁用、开关在设置页。
  if (givesAgentTools(manifest)) {
    adds.push(
      <AddsEntry key="tools" icon={<Wrench className="size-4" />} label={translate('extensions.addsTools')} testId="app-product-tools">
        <i>{translate(programs.length === 0 ? 'extensions.addsToolsSkillsOnly' : 'extensions.addsToolsAfterInstall', { programs: listOf(programs, locale) })}</i>
        {programs.length > 0 && manifest.contributes.skills ? <i>{translate('extensions.addsSkillsText')}</i> : null}
        {manifest.contributes.instructions ? (
          <span className="mk-instructions" data-testid="app-product-instructions">
            <span>{translate('extensions.addsInstructions')}</span>
            <q>{manifest.contributes.instructions}</q>
          </span>
        ) : null}
      </AddsEntry>
    );
  }
  if (ask) adds.push(ask);
  if (manifest.permissions?.capabilities?.includes('notifications')) {
    adds.push(
      <AddsEntry key="notify" icon={<Bell className="size-4" />} label={translate('extensions.addsNotify')}>
        <i>{translate('extensions.addsNotifyText')}</i>
      </AddsEntry>
    );
  }
  if (manifest.background && backgroundSupported) {
    adds.push(
      <AddsEntry key="background" icon={<Moon className="size-4" />} label={translate('extensions.addsBackground')}>
        <i>{translate('extensions.permissionsBackground')}</i>
      </AddsEntry>
    );
  }
  const addsSection = (
    <section className="mk-dsec" key="adds" data-testid="app-product-adds">
      <h3>{translate('extensions.whatItAdds')}</h3>
      {/* 一项一行,左边图标,右边名目和一句话;不套框 —— 整页唯一的框留给权限。 */}
      <div className="mk-adds">{adds}</div>
    </section>
  );

  // ── 权限:它能看 / 它能做 ──
  const see = permissions.filter((permission) => permissionSide(permission) === 'see');
  const act = permissions.filter((permission) => permissionSide(permission) === 'do');
  const permissionGroup = (side: 'see' | 'do', list: DeclaredPermission[]) =>
    list.length === 0 ? null : (
      <div key={side}>
        <span className="mk-perm-k">{translate(side === 'see' ? 'extensions.permissionsSee' : 'extensions.permissionsDo')}</span>
        {list.map((permission) => {
          const commands = permission.kind === 'capability' && permission.key === 'agents:tools' ? programDetails(manifest, translate) : undefined;
          return (
            <div className="mk-pl" key={permission.key} data-testid={`app-permission-${permission.key}`}>
              <PermissionIcon permission={permission} side={side} />
              <span>
                {permission.kind === 'network'
                  ? translate('extensions.permissionsNetwork', { hosts: permission.host })
                  : describeCapability(permission.key, manifest, translate, machine)}
                {commands ? <pre>{`${commands.caption}\n${commands.lines.join('\n')}`}</pre> : null}
              </span>
            </div>
          );
        })}
      </div>
    );
  // 照 Google Play「数据安全」:先一句话,再一张带框的卡片(它这一节本来就画框,是整页唯一一张)。
  const permissionsSection = (
    <section className="mk-dsec" key="permissions" data-testid="app-product-permissions">
      <h3 className="flex items-center gap-1">
        {translate('extensions.detailPermissions')}
        {phoneAgentCapabilities.length > 0 ? <InfoTooltip label={translate('extensions.phoneAgentCapabilitiesLabel')} content={<>
          <p>{translate('extensions.phoneAgentCapabilitiesInfo')}</p>
          <ul className="list-disc pl-4">{phoneAgentCapabilities.map((capability) => <li key={capability}>{describeCapability(capability, manifest, translate, machine)}</li>)}</ul>
        </>} /> : null}
      </h3>
      <p className="mk-note">
        {translate(permissions.length === 0 ? 'extensions.permissionsNoteNone' : 'extensions.permissionsNoteInstall')}
      </p>
        <div className="mk-card">
          {permissions.length === 0 ? (
            <div className="mk-pl">
              <Lock className="size-4" />
              <span>{translate('extensions.permissionsNone')}</span>
            </div>
          ) : (
            <>
              {permissionGroup('see', see)}
              {permissionGroup('do', act)}
            </>
          )}
        </div>
    </section>
  );

  // ── 右边一栏:审核那张卡(照 Google Play 的「内容分级」卡)、链接、类似 App ──
  const links = [
    manifest.homepage && { label: translate('extensions.linkHomepage'), href: manifest.homepage },
    manifest.repository && { label: translate('extensions.linkRepository'), href: manifest.repository },
  ].filter((entry): entry is { label: string; href: string } => Boolean(entry));
  const sourceButton =
    cloud.source ? (
      // 市场记下的出包来源(仓 @ 提交 @ 目录,App 市场方案 10-07):打出这份字节的那份代码。早于这条记录的版本没有。
      <button type="button" className="mk-ext" title={marketSourceLabel(cloud.source)} onClick={() => cloud.source && onOpenExternal(marketSourceUrl(cloud.source))}>
        {translate('extensions.viewSource')}
        <ExternalLink className="size-3" />
      </button>
    ) : null;
  const side = (
    <aside className="mk-dside">
      <div className="mk-card mk-review" data-testid="app-product-review">
        <ShieldCheck className="size-6" />
        <div>
          <b>{translate('extensions.infoReviewed', { version: cloud.version })}</b>
          <span className="mk-review-k">{sourceButton ?? publisher}</span>
        </div>
      </div>
      {links.length > 0 ? (
        <section className="mk-dsec is-side">
          <h3>{translate('extensions.detailLinks')}</h3>
          <div className="mk-side-links">
            {links.map((link) => (
              <button type="button" className="mk-ext" key={link.href} onClick={() => onOpenExternal(link.href)}>
                {link.label}
                <ExternalLink className="size-3" />
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {similar.length > 0 ? (
        <section className="mk-dsec is-side" data-testid="app-product-similar">
          <h3>{translate('extensions.similarApps')}</h3>
          <div className="mk-similar">
            {similar.map((app) => (
              <button type="button" className="mk-similar-row" key={app.id} onClick={app.onOpen} data-testid={`app-product-similar-${app.id}`}>
                <span className="mk-icon is-56">
                  <ExtensionMonogram name={app.name} iconDataUrl={app.iconUrl} />
                </span>
                <span className="mk-similar-tx">
                  <b>{app.name}</b>
                  <span>{app.publisher}</span>
                  <i>{app.line}</i>
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );

  // ── 头上一排要点:数在上、名目在下,格子之间一根短竖线(照 Google Play)──
  const size = formatSize(cloud.bundleBytes);
  const minApp = cloud.minAppVersion ?? engineFloor(manifest);
  const permissionCount =
    permissions.length === 0
      ? translate('extensions.stripPermissionsNone')
      : translate('extensions.stripPermissionsCount', { count: permissions.length });
  const facts: { value: string; caption: string }[] = [
    { value: `v${cloud.version}`, caption: translate('extensions.stripVersion') },
    ...(publishedAt ? [{ value: shortDate(publishedAt, locale), caption: translate('extensions.factUpdated') }] : []),
    { value: size, caption: translate('extensions.stripSize') },
    { value: permissionCount, caption: translate('extensions.detailPermissions') },
    // App Store 产品页头上那一排同样有类别。
    { value: translate(`extensions.category.${category}`), caption: translate('extensions.infoCategory') },
  ];
  // 信息表:正文最后一节,平铺在页上(照 App Store 产品页的「信息」),❌ 收进弹框里。
  const info: [string, ReactNode][] = [
    [translate('extensions.stripVersion'), `v${cloud.version}`],
    ...(manifest.platforms?.length ? ([[translate('extensions.infoPlatforms'), listOf(manifest.platforms.map((platform) => translate(`extensions.platform.${platform}`)), locale)]] as [string, ReactNode][]) : []),
    ...(publishedAt ? ([[translate('extensions.updatedOn'), longDate(publishedAt, locale)]] as [string, ReactNode][]) : []),
    ...(minApp ? ([[translate('extensions.stripNeedsApp'), translate('extensions.stripAndUp', { version: minApp })]] as [string, ReactNode][]) : []),
    [translate('extensions.stripSize'), size],
    [translate('extensions.detailPermissions'), permissionCount],
    [translate('extensions.infoPublisher'), publisher],
    [translate('extensions.infoReview'), translate('extensions.infoReviewed', { version: cloud.version })],
    [translate('extensions.infoCategory'), translate(`extensions.category.${category}`)],
    ...(manifest.license ? ([[translate('extensions.infoLicense'), manifest.license]] as [string, ReactNode][]) : []),
  ];

  return (
    <div className="mk" data-testid="app-product-page" data-extension-id={manifest.id}>
      {/* 那台机器离线 / server 太旧(#6264):照旧能看(翻截图、看简介、点类似 App),装、卸、收回、装某一版一起灰。 */}
      <button type="button" className="mk-back" onClick={onBack} data-testid="app-product-back">
        <ChevronLeft className="size-3.5" />
        {backLabel ?? translate('extensions.title')}
      </button>
      <ResourceMenu resource={resource ?? { kind: 'app', target: { kind: 'app-detail', extensionId: manifest.id } }}><header className="mk-dh">
        <div className="mk-dh-main">
          <h2 className={cn('gg-type-display mk-dh-title', deprecated && 'is-deprecated')}>{text.name}</h2>
          {text.subtitle ? <p className="mk-dh-sub">{text.subtitle}</p> : null}
          <div className="mk-dh-by">
            <span>{publisher}</span>
          </div>
          <dl className="mk-facts" data-testid="app-product-strip">
            {facts.map((fact) => (
              <div key={fact.caption}>
                <dd>{fact.value}</dd>
                <dt>{fact.caption}</dt>
              </div>
            ))}
          </dl>
          <fieldset disabled={readOnly} className="contents" data-testid="extension-detail-actions">
            <div className="mk-acts" aria-busy={pending ? 'true' : undefined}>
              <AppLifecycleButton
                state={lifecycle}
                pending={pending}
                percent={pendingPercent}
                primary
                disabled={readOnly}
                translate={translate}
                onClick={onLifecycle}
                testId="app-product-action"
              />
              {onManage ? (
                <Button type="button" variant="outline" size="lg" onClick={onManage} data-testid="app-product-manage">
                  {translate('extensions.appSettings')}
                </Button>
              ) : null}
              {onForward ? (
                <Button type="button" variant="ghost" size="lg" onClick={onForward} data-testid="app-product-forward">
                  <Share2 className="size-4" />
                  {translate('extensions.forward')}
                </Button>
              ) : null}
            </div>
          </fieldset>
        </div>
        <span className="mk-icon is-hero">
          <ExtensionMonogram name={text.name} iconDataUrl={cloud.iconUrl ?? iconDataUrl} />
        </span>
      </header></ResourceMenu>

      {justInstalled ? (
        <div className="mk-banner" role="status" data-testid="app-product-installed">
          <Check className="size-3.5" />
          {translate('extensions.justInstalled')}
        </div>
      ) : installedVersion && installedVersion !== cloud.version ? (
        // 这一页说的是市场上这一版;装着的是别的版本时说一句,❌ 把两边的东西混在一页上。
        <div className="mk-banner" data-testid="app-product-installed-version">
          {translate('extensions.installedVersionNote', { version: installedVersion })}
        </div>
      ) : null}
      {/* 装不上 / 停止维护:一句话,带它的下一步。 */}
      {compat ? (
        <div className="mk-banner is-warn">
          {marketCompatText(compat, translate)}
        </div>
      ) : cloud.newerNeedsApp ? (
        // 给出的这一版装得了,只是还有更新的一版这台咕咕装不了:说出那一版,❌ 藏起来(market.ts `newerNeedsApp`)。
        <div className="mk-banner" data-testid="app-product-newer-needs-app">
          {translate('extensions.newerNeedsApp', { version: cloud.newerNeedsApp })}
        </div>
      ) : null}
      {deprecated ? (
        <div className="mk-banner is-warn">
          {deprecated.replacedBy
            ? translate('extensions.deprecatedRow', { name: deprecated.replacedBy })
            : (deprecated.note ?? translate('extensions.deprecated'))}
        </div>
      ) : null}

      <div className="mk-dbody">
        <div className="mk-dmain">
          {screenshots}
          {about}
          {news}
          {addsSection}
          {permissionsSection}
          <section className="mk-dsec" data-testid="app-product-info">
            <h3>{translate('extensions.info')}</h3>
            <dl className="mk-info-grid">
              {info.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        {side}
      </div>

    </div>
  );
}

export function PermissionIcon({ permission, side }: { permission: DeclaredPermission; side: 'see' | 'do' }) {
  // 照原型:看 = 眼睛;做按做的是什么(跑程序 / 替 agent 动手 / 通知 / 替人发话 / 联网),其余一支笔。
  if (side === 'see') return <Eye className="size-4" />;
  if (permission.kind === 'network') return <Globe className="size-4" />;
  if (permission.key === 'agents:tools') return <Terminal className="size-4" />;
  if (permission.key.startsWith('agents:control')) return <Users className="size-4" />;
  if (permission.key === 'notifications') return <Bell className="size-4" />;
  if (permission.key === 'chat:relay') return <MessageCircle className="size-4" />;
  return <Pencil className="size-4" />;
}

/** 「2026年10月8日」:关于此 App 里的更新日期(照 Google Play 写全)。 */
function longDate(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** 截图的语言(manifest 的 defaultLocale)不是界面语言时,那种语言用界面语言怎么叫;是同一种就是 null。 */
export function screenshotsLanguage(manifest: Pick<ExtensionManifest, 'defaultLocale'>, locale: string): string | null {
  const language = manifest.defaultLocale.split('-')[0]!;
  if (language === locale.split('-')[0]) return null;
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}

/** 一种语言用它自己的名字叫(「中文」「English」),语言切换照惯例都这么写。 */
function languageName(language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}

/** 字节数 → 「640 KB」「2.1 MB」。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 几样东西连成一句(「A、B 和 C」/「A, B, and C」),❌ 拿 · 串。 */
export function listOf(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/** 「装上后多了什么」那张卡里的一行:左边一个图标,右边名目(粗)和内容。 */
function AddsEntry({ icon, label, testId, children }: { icon: ReactNode; label: string; testId?: string; children: ReactNode }) {
  return (
    <div className="mk-add" data-testid={testId}>
      {icon}
      <div>
        <b>{label}</b>
        {children}
      </div>
    </div>
  );
}

/** manifest 自己写的 `engines.gugu` 下界(`>=0.2.40` / `^0.2.40` → `0.2.40`)。 */
function engineFloor(manifest: ExtensionManifest): string | null {
  return manifest.engines?.gugu.replace(/^(>=|\^)/, '') ?? null;
}
