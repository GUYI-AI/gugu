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

export { LOCAL_HOST, PHONE_HOST } from './extensions-api';
export { WORKSPACE_APP_ID } from '@shared/extensions/app-runtime-protocol';

export interface ExtensionTabContributionEntry {
  kind: ExtensionTabKind;
  extensionId: string;
  extensionName: string;
  title: string;
  hostSettings?: boolean;
  /** Width beside another page: none = half. */
  sideWidth?: number;
  /** A data URL re-encoded in main, so the privileged renderer never fetches anything an extension shipped. */
  iconDataUrl: string | null;
  enabled: boolean;
  preinstalled: boolean;
  /** Opened FOR a file, so never a tab of its own in a session (摩擦单 F95, F3). */
  forFiles: boolean;
  ownPage: boolean;
  /** Out of the menus, though a file or an agent can still open it. */
  hidden: boolean;
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
  readonly variants: NonNullable<InstalledExtensionsList['variants']>;
  readonly invalid: { dirName: string; reason: string }[];
  readonly icons: Record<string, string>;
  readonly appIcons: Record<string, string>;
  readonly dock: string[];
  readonly hiddenTabs: Record<string, string[]>;
  readonly disabled: string[];
  readonly autoUpdateOff: string[];
  readonly quit: string[];
  readonly origins: Record<string, ExtensionOrigin>;
  readonly disclosure: Record<string, ExtensionDisclosureLevel>;
  readonly openWithDefaults: Record<string, string>;
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

  appName(extensionId: string): string | undefined {
    const manifest = this.manifestFor(extensionId);
    return manifest && localizedManifestText(manifest, this.locale).name;
  }

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

  get enabledTabContributions(): ExtensionTabContributionEntry[] {
    return this.allTabContributions.filter((entry) => entry.enabled && entry.ownPage && !entry.hidden);
  }

  get residentTabContributions(): ExtensionTabContributionEntry[] {
    return this.allTabContributions.filter((entry) => entry.enabled);
  }

  mainTabOf(extensionId: string): ExtensionTabContributionEntry | null {
    const pages = this.allTabContributions.filter((entry) => entry.extensionId === extensionId && !entry.forFiles && !entry.perSession);
    // A card is the main page only of an App with nothing else (Data Lens): hiding an App's page never makes its card the page.
    const own = pages.filter((entry) => entry.ownPage);
    return (own.length > 0 ? own : pages).find((entry) => !entry.hidden) ?? null;
  }

  get dockedApps(): RailApp[] {
    return this.dock.flatMap((extensionId) => this.railApp(extensionId) ?? []);
  }

  get openableApps(): RailApp[] {
    return this.manifests.flatMap((manifest) => this.railApp(manifest.id) ?? []);
  }

  /** Also Apps whose tab only opens a chat's files (5-minute game ①). */
  get chatOpenableApps(): RailApp[] {
    return this.manifests.flatMap((manifest) => this.railApp(manifest.id) ?? this.chatFilesApp(manifest) ?? []);
  }

  private chatFilesApp(manifest: ExtensionManifest): RailApp | null {
    const tab = manifest.contributes.tabs.find((candidate) => declaredContexts(candidate).includes('chat'));
    if (!tab || !this.isEnabled(manifest.id) || this.isPreinstalled(manifest.id)) return null;
    const name = localizedManifestText(manifest, this.locale).name;
    return { extensionId: manifest.id, name, kind: extensionTabKind(manifest.id, tab.name), iconDataUrl: this.appIcons[manifest.id] ?? null };
  }

  private railApp(extensionId: string): RailApp | null {
    const main = this.mainTabOf(extensionId);
    // A preinstalled App is where the host puts it, not an App of the rail or a chat's App list besides (统筹 09-29, L3).
    if (!main || !main.enabled || main.preinstalled) return null;
    return { extensionId, name: main.extensionName, kind: main.kind, iconDataUrl: this.appIcons[extensionId] ?? null };
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

const ticks = new Map<string, IObservableValue<number>>();

/** For a MobX computed/reaction: a tick per host, no data held. */
export function peekInstalledAppsTracked(hostKey: string = LOCAL_HOST): InstalledApps | null {
  let tick = ticks.get(hostKey);
  if (!tick) {
    const box = observable.box(0);
    const bump = () => runInAction(() => box.set(box.get() + 1));
    installedExtensions.subscribe([hostKey], bump);
    subscribeLocale(bump);
    ticks.set(hostKey, (tick = box));
  }
  tick.get();
  return peekInstalledApps(hostKey);
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

/** The 「App」 badge: enabled Apps with an update, yanked or deprecated ones, each once; pinned ones count (owner 10-19). */
export function updateCountOf(summary: MarketUpdatesSummary, apps: InstalledApps): number {
  return new Set<string>([
    ...Object.keys(summary.updates).filter((id) => apps.isEnabled(id)),
    ...Object.keys(summary.forkBehind ?? {}).filter((id) => apps.isEnabled(id)),
    ...Object.keys(summary.yanked),
    ...Object.keys(summary.deprecated),
  ]).size;
}
