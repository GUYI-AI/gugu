import { useMemo } from 'react';
import { observable, runInAction, type IObservableValue } from 'mobx';
import { getLocaleSnapshot, subscribeLocale } from '@/i18n';
import { useLocale } from '@/i18n/useLocale';
import { writeOver } from '@/lib/replicaWrite';
import { replica, useReplica, type Reading } from '@/lib/replica';
import { rpc } from '@renderer/lib/ipc';
import {
  declaredContexts,
  extensionTabKind,
  isOwnPage,
  parseExtensionTabKind,
  type ExtensionManifest,
  type ExtensionTabKind
} from '@shared/extensions/manifest';
import { localizedManifestText, localizedPromptText, localizedTabText } from '@shared/extensions/catalog';
import { fileIconKey } from '@shared/extensions/app-icon';
import { fileOpenersFor } from '@shared/extensions/file-openers';
import type { FileOpenContext } from '@shared/extensions/manifest';
import type { MarketUpdatesSummary } from '@shared/extensions/market';
import type { ExtensionOrigin } from '@shared/extensions/upgrade';
import { SIDE_PAGE_WIDTH_PX } from '@renderer/features/tabs/side-width';
import { extensionsApiOf, INSTALLED, LOCAL_HOST, PHONE_HOST, phoneStore, unwrap } from './extensions-api';

// @@@installed-extensions — what a host (`local`, `remote:<deviceId>` #6264, `phone`) has installed (@@@client-state-model).
// The main process (or the phone's App store, L9) owns the truth; this mirrors it so menus draw without an await.

export { LOCAL_HOST, PHONE_HOST } from './extensions-api';
export { WORKSPACE_APP_ID } from '@shared/extensions/app-runtime-protocol';

export interface ExtensionTabContributionEntry {
  /** Tab kind under which this contribution registers: `<extensionId>.<tabName>`. */
  kind: ExtensionTabKind;
  extensionId: string;
  extensionName: string;
  title: string;
  hostSettings?: boolean;
  /** Width beside another page: none = half. */
  sideWidth?: number;
  /** A data URL re-encoded in main, so the privileged renderer never fetches anything an extension shipped. */
  iconDataUrl: string | null;
  /** False while the extension is switched off: listed, not offered. */
  enabled: boolean;
  /** Shipped with gugu (origin `preinstalled`): drawn only from the host's own entries, never a session tab. */
  preinstalled: boolean;
  /**
   * The tab opens files (it claims some, in a task or a group): it is opened FOR a file, and a page of it with no file
   * has nothing to show — so it is never a tab of its own in a session (摩擦单 F95: 「Open a .todo-kanban.json file」 and
   * an uncaught error, in a tab nobody asked for; F3 for the group-only ones, whose session tab made a page at install).
   */
  forFiles: boolean;
  /** It stands alone as a page (`isOwnPage`): not a file opener, not the App's card in a message. */
  ownPage: boolean;
  /** The person took this page out of the menus (`hiddenTabs`): nothing offers it, though a file or an agent can still open it. */
  hidden: boolean;
  /** One page in each task (`perSession`): each task keeps its own, so it is never moved from one task to another. */
  perSession: boolean;
}

export type InstalledExtensionsApi = Pick<typeof rpc.extensions, 'list' | 'marketUpdates' | 'setDisclosure' | 'setAutoUpdate'>;

export type InstalledExtensionsList = NonNullable<Awaited<ReturnType<InstalledExtensionsApi['list']>>['data']> & {
  /** The phone only: why its App store index could not be read. */
  unreadable?: string | null;
};

export type ExtensionDisclosureLevel = 'full' | 'progressive';

export interface RailApp {
  extensionId: string;
  name: string;
  kind: string;
  iconDataUrl: string | null;
}

export const installedExtensions = replica({
  name: 'installedExtensions',
  tags: [INSTALLED],
  scope: 'device',
  read: async (_owner: string, hostKey: string): Promise<InstalledExtensionsList> =>
    hostKey === PHONE_HOST ? phoneStore('list')() : unwrap(await extensionsApiOf(hostKey).list(), 'The extensions list'),
  fresh: Infinity,
});

export class InstalledApps {
  readonly manifests: ExtensionManifest[];
  /** Optional per-App metadata, read with the inventory; unreadable entries have no variant picker. */
  readonly variants: NonNullable<InstalledExtensionsList['variants']>;
  /** Bundles present but unreadable — surfaced rather than silently skipped. */
  readonly invalid: { dirName: string; reason: string }[];
  /** Tab kind → host-rendered icon, and `fileIconKey` → a declared file icon (`fileIcons`). Absent means the generic mark. */
  readonly icons: Record<string, string>;
  /** App id → its own icon, host-rendered at the rail's size. Absent means the rail draws its first letter. */
  readonly appIcons: Record<string, string>;
  /** The Apps pinned to the far-left rail, in order (this machine's dock). */
  readonly dock: string[];
  /** The pages the person took out of the menus, by App (this machine's). */
  readonly hiddenTabs: Record<string, string[]>;
  /** Ids the user has switched off — installed, listed, but not offered (#5265). */
  readonly disabled: string[];
  /** Market Apps not updated by themselves (owner 10-19): switched off, or an older version picked. Main's, mirrored. */
  readonly autoUpdateOff: string[];
  /** Ids quit from the rail and not opened since (#7050): on, but their background is not running. Main's, mirrored. */
  readonly quit: string[];
  /**
   * Where each installed App came from (E-05): `preinstalled` for the ones gugu ships and installs itself
   * (preinstalled-apps.ts); none for one installed before origins were kept.
   */
  readonly origins: Record<string, ExtensionOrigin>;
  /** Extensions that give agents tools: listed up front in new sessions (`full`) or looked up on demand. */
  readonly disclosure: Record<string, ExtensionDisclosureLevel>;
  /** 「始终用它」: `<context>:<suffix>` → tab kind (or the built-in editor), kept in main. */
  readonly openWithDefaults: Record<string, string>;
  /** Who published each App installed from a chat (摩擦单 F66): `{ [extensionId]: { id, name } }`. */
  readonly publishers: Record<string, { id: string; name?: string }>;
  readonly unreadable: string | null;
  private tabs: ExtensionTabContributionEntry[] | null = null;

  constructor(readonly list: InstalledExtensionsList, readonly locale: string) {
    this.manifests = list.extensions;
    this.variants = list.variants ?? {};
    this.invalid = list.invalid;
    this.icons = list.icons ?? {};
    this.appIcons = list.appIcons ?? {};
    this.dock = list.dock ?? [];
    this.hiddenTabs = list.hiddenTabs ?? {};
    this.disabled = list.disabled ?? [];
    this.autoUpdateOff = list.autoUpdateOff ?? [];
    this.quit = list.quit ?? [];
    this.origins = (list.origins ?? {}) as Record<string, ExtensionOrigin>;
    this.disclosure = list.disclosure ?? {};
    this.openWithDefaults = list.openWith ?? {};
    this.publishers = list.publishers ?? {};
    this.unreadable = list.unreadable ?? null;
  }

  manifestFor(extensionId: string): ExtensionManifest | undefined {
    return this.manifests.find((manifest) => manifest.id === extensionId);
  }

  /** An installed App's name as the person reads it: in the interface language, as its manifest's `localized` says it there. */
  appName(extensionId: string): string | undefined {
    const manifest = this.manifestFor(extensionId);
    return manifest && localizedManifestText(manifest, this.locale).name;
  }

  /** Shipped with gugu (origin `preinstalled`): updated with gugu, never uninstalled or switched off here. */
  isPreinstalled(extensionId: string): boolean {
    return this.origins[extensionId] === 'preinstalled';
  }

  hiddenTabsOf(extensionId: string): string[] {
    return this.hiddenTabs[extensionId] ?? [];
  }

  isEnabled(extensionId: string): boolean {
    return !this.disabled.includes(extensionId);
  }

  /** Only a market App has the switch (null for the rest). */
  autoUpdates(extensionId: string): boolean | null {
    return this.origins[extensionId] === 'market' ? !this.autoUpdateOff.includes(extensionId) : null;
  }

  /** An App's `chatFile` is its own state, not the person's document (its tab goes by the App's name); suffix optional. */
  isChatFile(kind: string | null | undefined, fileName: string | undefined): boolean {
    const tabName = kind ? parseExtensionTabKind(kind) : null;
    const tab = tabName && this.manifestFor(tabName.extensionId)?.contributes.tabs.find((candidate) => candidate.name === tabName.tabName);
    const chatFile = tab?.chatFile?.toLowerCase();
    const name = fileName?.toLowerCase();
    return !!chatFile && !!name && (chatFile === name || chatFile.startsWith(`${name}.`));
  }

  /**
   * The icon the App behind tab `kind` declared for this file (`fileIcons`, by the most specific claim of that tab that
   * takes it), or null: the host's file mark then, never the App's own icon. The folder list draws the same declaration
   * (app-files.ts `claimant`).
   */
  fileIcon(kind: string, fileName: string, context: FileOpenContext): string | null {
    const manifest = this.manifestFor(parseExtensionTabKind(kind)?.extensionId ?? '');
    const claim = manifest ? fileOpenersFor(fileName, [manifest], context).find((candidate) => candidate.tabKind === kind)?.suffix : undefined;
    return claim ? this.icons[fileIconKey(kind, claim)] ?? null : null;
  }

  /** A default App page uses its localized name; specifically named subpages keep their contribution title. */
  tabTitle(kind: string): string | undefined {
    const tab = this.allTabContributions.find((entry) => entry.kind === kind);
    return tab && (this.mainTabOf(tab.extensionId)?.kind === kind ? tab.extensionName : tab.title);
  }

  sideWidth(kind: string): number | undefined {
    return this.allTabContributions.find((entry) => entry.kind === kind)?.sideWidth;
  }

  /** Enabled Apps' `/` prompts; other languages' titles kept for search. */
  get appPrompts(): { key: string; appName: string; title: string; prompt: string; otherTitles: string[] }[] {
    return this.manifests.filter((manifest) => this.isEnabled(manifest.id)).flatMap((manifest) => {
      const appName = localizedManifestText(manifest, this.locale).name;
      return (manifest.contributes.prompts ?? []).map((prompt) => {
        const text = localizedPromptText(manifest, prompt, this.locale);
        const titles = [prompt.title, ...Object.values(manifest.localized ?? {}).map((entry) => entry.prompts?.[prompt.name]?.title)];
        return { key: `${manifest.id}/${prompt.name}`, appName, ...text, otherTitles: [...new Set(titles)].filter((title): title is string => !!title && title !== text.title) };
      });
    });
  }

  /** Every declared tab, preinstalled Apps' included — what a lookup by kind reads. */
  get allTabContributions(): ExtensionTabContributionEntry[] {
    this.tabs ??= this.manifests.flatMap((manifest) => {
      const name = localizedManifestText(manifest, this.locale).name;
      return manifest.contributes.tabs.map((tab) => ({
        kind: extensionTabKind(manifest.id, tab.name),
        extensionId: manifest.id,
        extensionName: name,
        title: tab.hostPage ? name : localizedTabText(manifest, tab, this.locale).title,
        hostSettings: tab.hostPage === 'settings',
        sideWidth: tab.hostPage === 'settings' ? SIDE_PAGE_WIDTH_PX : tab.sideWidth,
        iconDataUrl: this.icons[extensionTabKind(manifest.id, tab.name)] ?? null,
        enabled: this.isEnabled(manifest.id),
        preinstalled: this.isPreinstalled(manifest.id),
        forFiles: declaredContexts(tab).length > 0,
        ownPage: isOwnPage(manifest, tab),
        hidden: this.hiddenTabs[manifest.id]?.includes(tab.name) === true,
        perSession: tab.perSession === true,
      }));
    });
    return this.tabs;
  }

  /**
   * The tabs a task session can have of their own — one list for every way a task opens one (its「+」, its empty pane, the
   * phone's task page): the tabs that open no file, of the Apps that are on. A switched-off App is left out, not greyed:
   * the menus list what can be opened (owner 10-20); switching it on is the 「App」 page's.
   */
  get enabledTabContributions(): ExtensionTabContributionEntry[] {
    return this.allTabContributions.filter((entry) => entry.enabled && entry.ownPage && !entry.hidden);
  }

  /** Every enabled App's resident page, preinstalled ones included: what the resident layer keeps alive. */
  get residentTabContributions(): ExtensionTabContributionEntry[] {
    return this.allTabContributions.filter((entry) => entry.enabled);
  }

  /**
   * An App's page of its own — its first tab that opens no file and is not one per task — or null: what the rail opens, if
   * it can be pinned. A page per task is in many places at once, so it has no one place for the rail to go to.
   */
  mainTabOf(extensionId: string): ExtensionTabContributionEntry | null {
    const pages = this.allTabContributions.filter((entry) => entry.extensionId === extensionId && !entry.forFiles && !entry.perSession);
    // A card is the main page only of an App with nothing else (Data Lens): hiding an App's page never makes its card the page.
    const own = pages.filter((entry) => entry.ownPage);
    return (own.length > 0 ? own : pages).find((entry) => !entry.hidden) ?? null;
  }

  /**
   * The Apps that open in `place`, in the order they were installed, each with the tab that opens there — read from what
   * their tabs declare, so every list of Apps is whole the moment it is drawn. `page`: an App's page of its own (the rail,
   * a task, a right click on 「App」). `chat`: that page beside the chat, or else a tab that opens a chat's files — an
   * agent's group game opens on its file (5-minute game ①); picking it says what it opens here (`appInChat`). On, and not
   * one gugu ships: those the host places itself — decided by origin, not manifest (统筹 09-29, L3).
   */
  appsIn(place: 'page' | 'chat'): RailApp[] {
    return this.manifests.flatMap((manifest) => {
      if (!this.isEnabled(manifest.id) || this.isPreinstalled(manifest.id)) return [];
      const page = this.mainTabOf(manifest.id)?.kind;
      const files = place === 'chat' ? manifest.contributes.tabs.find((tab) => declaredContexts(tab).includes('chat')) : undefined;
      const kind = page ?? (files && extensionTabKind(manifest.id, files.name));
      return kind ? [{ extensionId: manifest.id, name: localizedManifestText(manifest, this.locale).name, kind, iconDataUrl: this.appIcons[manifest.id] ?? null }] : [];
    });
  }

  /** What the rail shows: the pinned Apps that open as a page, in the person's order. */
  get dockedApps(): RailApp[] {
    const apps = this.appsIn('page');
    return this.dock.flatMap((extensionId) => apps.find((app) => app.extensionId === extensionId) ?? []);
  }
}

const built = new WeakMap<InstalledExtensionsList, Map<string, InstalledApps>>();

export function appsOf(list: InstalledExtensionsList, locale: string): InstalledApps {
  let byLocale = built.get(list);
  if (!byLocale) built.set(list, (byLocale = new Map()));
  let apps = byLocale.get(locale);
  if (!apps) byLocale.set(locale, (apps = new InstalledApps(list, locale)));
  return apps;
}

export function useInstalledApps(hostKey: string | null, options: { read?: boolean } = {}): Reading<InstalledApps> {
  const reading = useReplica(installedExtensions, hostKey ? [hostKey] : null, options);
  const { resolvedLocale } = useLocale();
  return useMemo((): Reading<InstalledApps> => {
    if (reading.state !== 'value') return reading;
    return { ...reading, value: appsOf(reading.value, resolvedLocale) };
  }, [reading, resolvedLocale]);
}

export function peekInstalledApps(hostKey: string = LOCAL_HOST): InstalledApps | null {
  const reading = installedExtensions.peek(hostKey);
  return reading.state === 'value' ? appsOf(reading.value, getLocaleSnapshot().resolvedLocale) : null;
}

export async function fetchInstalledApps(hostKey: string = LOCAL_HOST): Promise<InstalledApps> {
  const now = peekInstalledApps(hostKey);
  if (now) return now;
  return appsOf(await installedExtensions.fetch(hostKey), getLocaleSnapshot().resolvedLocale);
}

const held = new Map<string, IObservableValue<InstalledApps | null>>();

/**
 * For a MobX computed/reaction, or a render: the installed apps as of the last change. The box is set when the apps or
 * the locale change, so a read is a box read — renders read this many times per frame, and looking the apps up in the
 * replica each time hashed its key every time.
 */
export function peekInstalledAppsTracked(hostKey: string = LOCAL_HOST): InstalledApps | null {
  let box = held.get(hostKey);
  if (!box) {
    const apps = observable.box(peekInstalledApps(hostKey), { deep: false });
    const refresh = () => runInAction(() => apps.set(peekInstalledApps(hostKey)));
    installedExtensions.subscribe([hostKey], refresh);
    subscribeLocale(refresh);
    held.set(hostKey, (box = apps));
  }
  return box.get();
}

export function writeInstalled<R>(
  hostKey: string,
  optimistic: ((list: InstalledExtensionsList) => InstalledExtensionsList) | null,
  write: () => Promise<R>,
  settled: (answer: R) => (list: InstalledExtensionsList) => InstalledExtensionsList
): Promise<R> {
  const patched = (patch: (list: InstalledExtensionsList) => InstalledExtensionsList) => (old: InstalledExtensionsList | undefined) => old && patch(old);
  return writeOver(installedExtensions, [hostKey], optimistic && patched(optimistic), write, (answer) => patched(settled(answer)));
}

export async function setAutoUpdate(hostKey: string, extensionId: string, on: boolean): Promise<void> {
  await writeInstalled(hostKey, null,
    async () => unwrap(await extensionsApiOf(hostKey).setAutoUpdate({ extensionId, on }), 'The auto-update switch').autoUpdateOff,
    (autoUpdateOff) => (list) => ({ ...list, autoUpdateOff }));
}

export async function setDisclosure(hostKey: string, extensionId: string, level: ExtensionDisclosureLevel): Promise<void> {
  const apps = peekInstalledApps(hostKey);
  if (!apps?.disclosure[extensionId]) throw new Error(`${extensionId} gives agents no tools`);
  await writeInstalled(hostKey, (list) => ({ ...list, disclosure: { ...list.disclosure, [extensionId]: level } }),
    async () => unwrap(await extensionsApiOf(hostKey).setDisclosure({ extensionId, level }), 'The disclosure switch').level,
    (settledLevel) => (list) => ({ ...list, disclosure: { ...list.disclosure, [extensionId]: settledLevel } }));
}

/** A 「始终用它」 kept (or, `null`, let go — 摩擦单 F73). */
export function noteOpenWithDefault(hostKey: string, key: string, tabKind: string | null): void {
  installedExtensions.set([hostKey], (list) => {
    if (!list) return list;
    const { [key]: _dropped, ...rest } = list.openWith ?? {};
    return { ...list, openWith: tabKind === null ? rest : { ...rest, [key]: tabKind } };
  });
}

/** `offered`: update version per App; `gone`: no longer in the market; `summary` absent = restored (only the first two kept). */
export type MarketUpdates = { offered: Record<string, string>; gone: string[]; summary?: MarketUpdatesSummary };

/**
 * What the market says of a host's installed Apps (#5410): a newer version, this one withdrawn, deprecated. Read at start
 * and when the App page opens, and again when the catalog in hand changed (wire-market-refresh.ts); ❌ polled.
 */
export const marketUpdates = replica({
  name: 'marketUpdates',
  tags: [INSTALLED],
  scope: 'device',
  read: async (_owner: string, hostKey: string): Promise<MarketUpdates> => {
    const summary = hostKey === PHONE_HOST ? await phoneStore('marketUpdates')() : unwrap(await extensionsApiOf(hostKey).marketUpdates(), 'The update check');
    return { offered: Object.fromEntries(Object.entries(summary.updates).map(([id, update]) => [id, update.version])), gone: summary.gone ?? [], summary };
  },
  fresh: Infinity,
});

/**
 * The number on the 「App」 badge: the Apps with an update, withdrawn or deprecated, each counted once though it may be all
 * three. Pinned ones (kept on an older version) count (owner 10-19, as VS Code's `outdated` compares versions only —
 * https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts#L338-L360 );
 * a switched-off App's update does not (the badge counts enabled ones; it sits in the 「已停用」 group), its withdrawal
 * or deprecation does —
 * https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsViewlet.ts#L1040-L1071 .
 */
export function updateCountOf(summary: MarketUpdatesSummary, apps: InstalledApps): number {
  return new Set<string>([
    ...Object.keys(summary.updates).filter((id) => apps.isEnabled(id)),
    ...Object.keys(summary.forkBehind ?? {}).filter((id) => apps.isEnabled(id)),
    ...Object.keys(summary.yanked),
    ...Object.keys(summary.deprecated),
  ]).size;
}
