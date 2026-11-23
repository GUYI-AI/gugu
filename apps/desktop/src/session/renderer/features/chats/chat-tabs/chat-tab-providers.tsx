import { observer } from 'mobx-react-lite';
import { createContext, useCallback, useContext, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Users } from '@/lib/icons';
import { AppFileMark } from '@renderer/features/extensions/app-file-mark';
import { chatTabSlotKey, readShellSlots } from '@/lib/shellSlots';
import { useChatFolderName } from '@/components/chat/chatFolderName';
import { RailAppIcon } from '@/components/RailAppIcon';
import { FileHostMark } from '@/components/appSlot/FileHostMark';
import { openFileStorageSettings, useFileHost } from '@/lib/fileHost';
import { extensionSurfaceStore, extensionTabTitle } from '@renderer/features/extensions/extension-surface-store';
import { extensionViewStore } from '@renderer/features/extensions/extension-view-store';
import { LOCAL_HOST, peekInstalledAppsTracked, useInstalledApps, type InstalledApps } from '@renderer/features/extensions/installed-extensions';
import { Unknown } from '@/components/ui/Unknown';
import { declaredMenuCommands, runExtensionCommand } from '@renderer/features/extensions/extension-commands';
import { ExtensionTabBadge } from '@renderer/features/extensions/extension-tab-badge';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab, TabBarItemProps, TabContentProps, TabEntry, TabResource, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { createTabProvider } from '@renderer/features/tabs/core/tab-provider-registry';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { groupPageSlot, isFolderItem, panelItemKey, WORKSPACE_APP_KIND, type PanelItem } from './chat-panel-item';
import { TabKindMark } from '@renderer/features/extensions/extension-mark';
import { takeRestore } from './chat-tab-restores';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { RetainedTabContent, useRetainedTabs } from '@renderer/features/tabs/retained-tab-content';
import { SIDE_PAGE_WIDTH_PX } from '@renderer/features/tabs/side-width';

/** The chat itself: its messages and composer, first in its strip, never closed. */
export const CHAT_TAB_KIND = 'chat';
/** Something open beside the messages (`PanelItem`): an App's page, a file in the App that opens it, the host's preview. */
export const CHAT_PANEL_TAB_KIND = 'chat-panel';
/**
 * The chat's info (owner 10-26: one place for what the chat is — its members, announcement, settings): a tab like the
 * folder's, one a chat; `page` is where it was opened at (the members' button: their list), `at` tells two opens apart.
 */
export const CHAT_INFO_TAB_KIND = 'chat-info';

/** The narrowest a conversation is drawn: under it, messages are not readable. */
export const CHAT_MIN_WIDTH_PX = 360;

export type ChatTabState = { chatId: string };
export type ChatInfoState = { group: boolean; page?: 'main' | 'members' | 'announcement'; at?: number };

/** The chat a strip belongs to (its place, `chat-layouts`). */
export const chatIdOfView = (ctx: TabViewContext): string => (ctx.place?.kind === 'chat' ? ctx.place.chatId : '');

/**
 * What the block holding a chat's strip draws for the chat's own tab — its chip (the project's name or the chat's
 * avatar and name, with that block's menu) and its body (the messages the shell draws into the block's slot).
 */
export interface ChatTabHost {
  chip: (props: { tab: ResolvedTab; host: TabHost }) => ReactNode;
  body: ReactNode;
  /** 「单独一块」 for an App's tab, where the strip is in a block of the screen (a window has none). */
  ownBlock?: (tabId: string) => void;
}
export const ChatTabHostContext = createContext<ChatTabHost | null>(null);

/**
 * Nothing to hold: what a tab shows lives in its state, its page in the shell or the App's layer. The resource only lets
 * the strip read that state (the engine hands tab chips resolved tabs, not entries).
 */
export class ChatTabResource<S> implements TabResource {
  constructor(private readonly entry: TabEntry<S>) {}
  get state(): S {
    return this.entry.state;
  }
  dispose(): void {}
}
const stateResource = <S,>(entry: TabEntry<S>) => new ChatTabResource(entry);
const stateOf = <S,>(tab: ResolvedTab): S => (tab.resource as ChatTabResource<S>).state;

const ChatTabItem = observer(function ChatTabItem({ tab, host }: TabBarItemProps<TabResource>) {
  return <>{useContext(ChatTabHostContext)?.chip({ tab, host }) ?? null}</>;
});

const ChatTabContent = observer(function ChatTabContent(_props: TabContentProps) {
  return <div className="flex h-full w-full min-h-0 min-w-0 flex-col">{useContext(ChatTabHostContext)?.body ?? null}</div>;
});

export const chatTabProvider = createTabProvider<typeof CHAT_TAB_KIND, ChatTabState, TabResource>({
  kind: CHAT_TAB_KIND,
  conversation: true,

  resourceKey: () => 'chat',
  minWidth: CHAT_MIN_WIDTH_PX,
  // 别的页签的页、对话的名字和右端按钮都由对话画:它一直挂着(没上屏就藏着)。
  keepMounted: true,
  initialize: stateResource,
  // The chat is the strip's first tab, as a task's conversation is its own: ⌘W, 「关闭全部」 leave it.
  onBeforeClose: () => false,
  dispose: () => {},
  TabBarItem: ChatTabItem,
  TabBarItemDragPreview: () => null,
  TabContent: ChatTabContent,
});

/** A chat file the person opened (not an App's own chat file): its tab is named and marked by the file, whichever App shows it. */
const showsFile = (item: PanelItem, apps: InstalledApps | null) => !!item.itemId && !apps?.isChatFile(item.kind, item.fileName);

/** A panel tab's name as its strip says it: what its page called itself, else the file's name, else the App's tab title. */
function usePanelPresentation(chatId: string, tabId: string, item: PanelItem) {
  const folderName = useChatFolderName();
  const installed = useInstalledApps(LOCAL_HOST);
  const said = extensionSurfaceStore.said(null, groupPageSlot(chatId, tabId));
  if (!isFolderItem(item) && item.kind && installed.state === 'unknown') {
    return { ...extensionTabTitle(said, said.title ?? ''), unknown: said.title === null };
  }
  const apps = installed.state === 'value' ? installed.value : null;
  const file = showsFile(item, apps) ? { name: item.title, path: item.fileName ?? item.title } : undefined;
  return {
    ...extensionTabTitle(
      said,
      isFolderItem(item) ? folderName : item.kind && apps && !file ? (apps.tabTitle(item.kind) ?? item.title) : item.title,
      file,
    ),
    unknown: false,
  };
}

function PanelIcon({ item }: { item: PanelItem }) {
  const installed = useInstalledApps(LOCAL_HOST);
  if (isFolderItem(item)) return <TabKindMark kind={WORKSPACE_APP_KIND} />;
  const apps = installed.state === 'value' ? installed.value : null;
  const extensionId = item.kind && (installed.state === 'unknown' || !showsFile(item, apps)) ? parseExtensionTabKind(item.kind)?.extensionId : undefined;
  if (extensionId && installed.state === 'unknown') return <Unknown className="size-4 shrink-0" />;
  const app = extensionId && apps ? apps.appsIn('page').find((candidate) => candidate.extensionId === extensionId) : undefined;
  return app ? <RailAppIcon app={app} className="size-4" /> : <AppFileMark kind={item.kind} fileName={item.fileName ?? item.title} context="chat" size={14} />;
}

const PanelTabItem = observer(function PanelTabItem({ tab, host, ctx }: TabBarItemProps<TabResource>) {
  const item = stateOf<PanelItem>(tab);
  const chatId = chatIdOfView(ctx);
  const { label, hint, tooltip, unknown } = usePanelPresentation(chatId, tab.tabId, item);
  const surface = extensionSurfaceStore.said(null, groupPageSlot(chatId, tab.tabId));
  const ownBlock = useContext(ChatTabHostContext)?.ownBlock;
  const { t } = useTranslation('messaging');
  // A project chat's file kept on its machine: the machine mark after the name, as its folder row and its page header put it; its setting one ⋯ away (owner 10-27).
  const fileHost = useFileHost(item.itemId && !isFolderItem(item) ? item.itemId : null);
  // 「单独一块」(spec session-page「一屏几块」,同任务里 App 那一枚):这张页自己占一块,贴在这一块右边;这个对话里就不留它了。
  // App 声明的菜单命令跟在后面,同任务里的 App 页签(工具栏那一行去掉了,owner 10-26 选 A)。
  const kindCommands = item.kind
    ? [
        ...(ownBlock ? [{ id: `${tab.tabId}:own-block`, label: translateSessionMessage('extensions.ownBlock'), group: 'extension', run: () => ownBlock(tab.tabId) }] : []),
        ...declaredMenuCommands(item.kind).map((command) => ({
          id: `${tab.tabId}:${command.id}`, label: command.title, group: 'extension', run: () => runExtensionCommand(null, groupPageSlot(chatId, tab.tabId), command.id),
        })),
      ]
    : [];
  if (fileHost) kindCommands.push({ id: `${tab.tabId}:file-storage`, label: t('fileStoredOn.settings'), group: 'file', run: openFileStorageSettings });
  return (
    <div className="contents" data-panel-tab={isFolderItem(item) ? 'folder' : (item.kind ?? 'preview')}>
      <GenericTabItem tab={tab} host={host} ctx={ctx} label={label} unknownLabel={unknown ? <Unknown className="w-20" /> : undefined} hint={hint} tooltip={tooltip} hasError={surface.error !== null} preSlot={<PanelIcon item={item} />} markSlot={fileHost ? <FileHostMark host={fileHost} /> : null} statusSlot={<ExtensionTabBadge badge={surface.badge} />} kindCommands={kindCommands} />
    </div>
  );
});

const PanelTabDragPreview = observer(function PanelTabDragPreview({ tab }: { tab: ResolvedTab }) {
  const item = stateOf<PanelItem>(tab);
  // A drag in progress: the tab it lifts was drawn from a known list (an App's tab), so its title is read as it is now.
  const apps = peekInstalledAppsTracked();
  const label = apps?.isChatFile(item.kind, item.fileName) ? apps.tabTitle(item.kind!) ?? item.title : item.title;
  return <GenericTabDragPreview preSlot={<PanelIcon item={item} />} label={label} />;
});

/**
 * One stable slot per recently viewed tab (either half of a pair): the shell draws what the tab shows into it
 * (components/chat/ChatTabPortals.tsx), in its own tree and contexts — the chat's state, the App's offer and update bar.
 * The task pane's bounded retention keeps its React tree and state when another tab is shown.
 */
const ShellTabSlots = observer(function ShellTabSlots({ host, ctx, kind }: TabContentProps & { kind: string }) {
  const chatId = chatIdOfView(ctx);
  const tabs = host.resolvedTabs;
  const retained = useRetainedTabs(tabs.map((tab) => tab.tabId), tabs.filter((tab) => tab.isActive).map((tab) => tab.tabId));
  return (
    <>
      {tabs.filter((tab) => tab.kind === kind && retained.has(tab.tabId)).map((tab) => (
        <ShellTabSlot key={tab.tabId} chatId={chatId} tab={tab} />
      ))}
    </>
  );
});

function ShellTabSlot({ chatId, tab, style }: { chatId: string; tab: ResolvedTab; style?: CSSProperties }) {
  const { tabId } = tab;
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(chatTabSlotKey(chatId, tabId), element), [chatId, tabId]);
  return <RetainedTabContent ref={ref} visible={tab.isActive} style={style} className="absolute inset-0 flex min-h-0 min-w-0 flex-col" data-chat-tab-slot={tabId} data-pane-tab={tabId} />;
}

function PanelTabContent(props: TabContentProps) {
  return <ShellTabSlots {...props} kind={CHAT_PANEL_TAB_KIND} />;
}

export const chatPanelTabProvider = createTabProvider<typeof CHAT_PANEL_TAB_KIND, PanelItem, TabResource>({
  kind: CHAT_PANEL_TAB_KIND,

  resourceKey: panelItemKey,
  // An App's own page beside the chat is as wide as its manifest says (`sideWidth`); a file is the chat's peer: half each.
  sideWidth: (item) => (item.kind && !item.itemId ? peekInstalledAppsTracked()?.sideWidth(item.kind) : undefined),
  // The host's preview holds a message and a file version of this moment: gone with the window, as before.
  isPersistent: (item) => item.kind !== null,
  initialize: stateResource,
  // Closing hands back what it was opened from (a link's message) — once the tab is
  // gone (the engine removes it after this answer), as closeChatTab does.
  onBeforeClose: (entry, _resource, ctx, request) => {
    if (request.navigation) return true;
    const restore = takeRestore(chatIdOfView(ctx), entry.state);
    if (restore) setTimeout(restore, 0);
    return true;
  },
  dispose: (entry, _resource, ctx) => extensionSurfaceStore.forget(null, groupPageSlot(chatIdOfView(ctx), entry.tabId)),
  closed: (tabId, ctx) => extensionViewStore.closeSlot(null, groupPageSlot(chatIdOfView(ctx), tabId)),
  TabBarItem: PanelTabItem,
  TabBarItemDragPreview: PanelTabDragPreview,
  TabContent: PanelTabContent,
});

// 第 16 版 #44:群、私聊、话题的这一页都叫「详情」(❌ 群信息 / 会话信息)。
const useInfoLabel = () => useTranslation('messaging').t('header.details');

const InfoTabItem = observer(function InfoTabItem({ tab, host, ctx }: TabBarItemProps<TabResource>) {
  return (
    <div className="contents" data-info-tab="">
      <GenericTabItem tab={tab} host={host} ctx={ctx} label={useInfoLabel()} preSlot={<Users size={14} />} />
    </div>
  );
});

const InfoTabDragPreview = observer(function InfoTabDragPreview(_props: { tab: ResolvedTab }) {
  return <GenericTabDragPreview preSlot={<Users size={14} />} label={useInfoLabel()} />;
});

function InfoTabContent(props: TabContentProps) {
  return <ShellTabSlots {...props} kind={CHAT_INFO_TAB_KIND} />;
}

export const chatInfoTabProvider = createTabProvider<typeof CHAT_INFO_TAB_KIND, ChatInfoState, TabResource>({
  kind: CHAT_INFO_TAB_KIND,
  isPersistent: () => true,
  resourceKey: (state) => `${state.page}:${state.at ?? ''}`,
  sideWidth: () => SIDE_PAGE_WIDTH_PX,
  initialize: stateResource,
  dispose: () => {},
  TabBarItem: InfoTabItem,
  TabBarItemDragPreview: InfoTabDragPreview,
  TabContent: InfoTabContent,
});
