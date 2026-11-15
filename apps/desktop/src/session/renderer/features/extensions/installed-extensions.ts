import { useMemo } from 'react';
import { observable, runInAction, type IObservableValue } from 'mobx';
import { getLocaleSnapshot, subscribeLocale } from '@/i18n';
import { useLocale } from '@/i18n/useLocale';
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
import type { MarketUpdatesSummary } from '@shared/extensions/market';
import type { ExtensionOrigin } from '@shared/extensions/upgrade';
import { SIDE_PAGE_WIDTH_PX } from '@renderer/features/tabs/side-width';
import { extensionsApiOf, LOCAL_HOST, PHONE_HOST } from './extensions-api';

/**
 * @@@installed-extensions — what is installed on a host (@@@client-state-model, PR 3: replaces `installedExtensionsStore`).
 * The host owns the truth (main scans the extensions directory; another desktop's main; the phone's own App store), this is
 * the replica of it. A host key: `local` (this desktop's main), `remote:<deviceId>` (another desktop, #6264), `phone`.
 *
 * Push (host tier, `fresh: Infinity`): main's inventory channel and the installed-changed method `refresh('local')`
 * (register-extension-tabs.ts), the quit channel and every write here put main's answer (`at().set`), the phone's store
 * `tell`s its list (phoneApps.ts). Everything drawn from it is a pure function of (list, locale): `InstalledApps`.
 */

export { LOCAL_HOST, PHONE_HOST } from './extensions-api';
export { WORKSPACE_APP_ID } from '@shared/extensions/app-runtime-protocol';

export interface ExtensionTabContributionEntry {
  /** Tab kind under which this contribution registers: `<extensionId>.<tabName>`. */
  kind: ExtensionTabKind;
  extensionId: string;
  extensionName: string;
  title: string;
  hostSettings?: boolean;
  /** Its width beside another page (manifest `sideWidth`; the host's settings page is a narrow form): none = half. */
  sideWidth?: number;
  /**
   * Host-produced PNG for this tab, or null for the generic mark. A data URL rather than a path: the bytes are re-encoded
   * in main precisely so the privileged renderer never fetches anything an extension shipped.
   */
  iconDataUrl: string | null;
  /** False while the extension is switched off: listed, not offered. */
  enabled: boolean;
  /** Shipped with gugu (origin `preinstalled`): drawn only from the host's own entries, never a session tab. */
  preinstalled: boolean;
  /**
   * The tab opens files (it claims some, in a task or a group): it is opened FOR a file, and a page of it with no file has
   * nothing to show — so it is never a tab of its own in a session (摩擦单 F95, F3).
   */
  forFiles: boolean;
  /** It stands alone as a page (`isOwnPage`): not a file opener, not the App's card in a message. */
  ownPage: boolean;
  /** The person took this page out of the menus (`hiddenTabs`): nothing offers it, though a file or an agent can still open it. */
  hidden: boolean;
  /** One page in each task (`perSession`): each task keeps its own, so it is never moved from one task to another. */
  perSession: boolean;
}

/** 这份清单问的是哪台机器(本机 = `rpc.extensions`;另一台咕咕桌面 = 经设备 RPC,#6264)。 */
export type InstalledExtensionsApi = Pick<typeof rpc.extensions, 'list' | 'marketUpdates' | 'setDisclosure' | 'setAutoUpdate'>;

/** What installed is, as main lists it — and the phone's App store says it in the same shape (L9). */
export type InstalledExtensionsList = NonNullable<Awaited<ReturnType<InstalledExtensionsApi['list']>>['data']> & {
  /** The phone only: why its App store index could not be read this page load (absent: it could). */
  unreadable?: string | null;
};

export type ExtensionDisclosureLevel = 'full' | 'progressive';

/** An App as the far-left rail draws it: its icon (or, absent, its first letter) and the page it opens. */
export interface RailApp {
  extensionId: string;
  name: string;
  kind: string;
  iconDataUrl: string | null;
}

/**
 * The rail's dock as last read, kept across restarts for its first frame (PLAN v2 C4). Only the first `DOCK_KEPT_SLOTS`
 * docked Apps, each `{extensionId, name}` whole or, when its name is longer than `DOCK_KEPT_NAME_MAX`, left out (null: its
 * slot draws a placeholder the size of an icon); `count` is how many Apps the dock has, so the slots past the kept ones are
 * placeholders too. Icons are host-rendered data URLs (1–6 KB each): not kept, the slot draws the App's monogram.
 */
export type KeptDock = { slots: ({ extensionId: string; name: string } | null)[]; count: number };

/** `list` is absent only in a value restored from the snapshot: what is installed is not known yet, only the dock. */
export type InstalledReading = { list?: InstalledExtensionsList; dock?: KeptDock };

/** How many of the dock's Apps the snapshot keeps: more than a rail shows on a laptop screen without scrolling. */
export const DOCK_KEPT_SLOTS = 12;
/** A name longer than this leaves its App out of the kept dock (whole, never cut short). */
export const DOCK_KEPT_NAME_MAX = 32;
// Bound: 12 slots × (id ≤ 64 + name ≤ 32 + JSON ≈ 32 = 128) + count and the entry's key/at/used ≈ 200 = 1,736 ≤ 2,048.

function keptDockOf(list: InstalledExtensionsList): KeptDock {
  const docked = appsOf(list, getLocaleSnapshot().resolvedLocale).dockedApps;
  return {
    slots: docked.slice(0, DOCK_KEPT_SLOTS).map(({ extensionId, name }) => (name.length <= DOCK_KEPT_NAME_MAX ? { extensionId, name } : null)),
    count: docked.length,
  };
}

let phoneList: (() => Promise<InstalledExtensionsList>) | null = null;
/** The phone's App store says how its list is read (phoneApps.ts registers it; it imports this module, not the other way). */
export function definePhoneInstalledList(read: () => Promise<InstalledExtensionsList>): void {
  phoneList = read;
}

async function readList(hostKey: string): Promise<InstalledExtensionsList> {
  if (hostKey === PHONE_HOST) {
    if (!phoneList) throw new Error('The phone App store is not loaded');
    return phoneList();
  }
  const result = await extensionsApiOf(hostKey).list();
  if (!result.success || !result.data) throw new Error(result.error ?? 'Failed to list extensions');
  return result.data;
}

export const installedExtensions = replica({
  name: 'installedExtensions',
  scope: 'device',
  read: async (_owner: string, hostKey: string): Promise<InstalledReading> => ({ list: await readList(hostKey) }),
  // Host-pushed: the inventory channel, the quit channel, the phone's `tell` and every write put or read it again.
  fresh: Infinity,
  persist: {
    maxBytes: 2048,
    maxEntries: 1,
    // Only this desktop's dock (the rail's first frame); a restored value (no list) is carried as it is.
    carry: (value: InstalledReading, hostKey: string) =>
      hostKey !== LOCAL_HOST ? undefined : value.list ? { dock: keptDockOf(value.list) } : value,
  },
});

// ── what is drawn: pure functions of (list, locale) ─────────────────────────────────────────────────────────────

/** Everything a surface derives from one host's list in one language. Built once per (list, locale) (`appsOf`). */
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

  /** An installed App's name as the person reads it: in the interface language, as its manifest's `localized` says it there. */
  appName(extensionId: string): string | undefined {
    const manifest = this.manifestFor(extensionId);
    return manifest && localizedManifestText(manifest, this.locale).name;
  }

  /** Shipped with gugu (origin `preinstalled`): updated with gugu, never uninstalled or switched off here. */
  isPreinstalled(extensionId: string): boolean {
    return this.origins[extensionId] === 'preinstalled';
  }

  /** The pages the person took out of an App's menus (none: it hides none). */
  hiddenTabsOf(extensionId: string): string[] {
    return this.hiddenTabs[extensionId] ?? [];
  }

  isEnabled(extensionId: string): boolean {
    return !this.disabled.includes(extensionId);
  }

  /** Whether this App is updated by itself: only a market App has the switch (null for the rest). */
  autoUpdates(extensionId: string): boolean | null {
    return this.origins[extensionId] === 'market' ? !this.autoUpdateOff.includes(extensionId) : null;
  }

  /**
   * The file an App names for a chat (`chatFile`) is that App's own state, not a document of the person's: its tab goes by
   * the App's name. `fileName` may also be the name shown for it, its claimed suffix dropped (a block keeps only that).
   */
  isChatFile(kind: string | null | undefined, fileName: string | undefined): boolean {
    const tabName = kind ? parseExtensionTabKind(kind) : null;
    const tab = tabName && this.manifestFor(tabName.extensionId)?.contributes.tabs.find((candidate) => candidate.name === tabName.tabName);
    const chatFile = tab?.chatFile?.toLowerCase();
    const name = fileName?.toLowerCase();
    return !!chatFile && !!name && (chatFile === name || chatFile.startsWith(`${name}.`));
  }

  /** A default App page uses its localized name; specifically named subpages keep their contribution title. */
  tabTitle(kind: string): string | undefined {
    const tab = this.allTabContributions.find((entry) => entry.kind === kind);
    return tab && (this.mainTabOf(tab.extensionId)?.kind === kind ? tab.extensionName : tab.title);
  }

  /** How wide this App page is beside another (`sideWidth`); undefined: half, a peer. */
  sideWidth(kind: string): number | undefined {
    return this.allTabContributions.find((entry) => entry.kind === kind)?.sideWidth;
  }

  /**
   * The prompts enabled Apps offer in the composer's `/` menu (`contributes.prompts`), in the reader's language, with the
   * App's name to group them under and the titles in its other languages for search.
   */
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
   * phone's task page): the tabs that open no file, of the Apps that are on. A switched-off App is left out, not greyed.
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

  /** What the rail shows: the pinned Apps that are installed, on, and have a page of their own, in the person's order. */
  get dockedApps(): RailApp[] {
    return this.dock.flatMap((extensionId) => this.railApp(extensionId) ?? []);
  }

  /** Every App the rail can open, pinned or not, in the order they were installed: what a right click on 「App」 lists. */
  get openableApps(): RailApp[] {
    return this.manifests.flatMap((manifest) => this.railApp(manifest.id) ?? []);
  }

  /**
   * What a group can open, in the order they were installed: the Apps with a page of their own, and the Apps whose tab opens
   * a chat's files — opened on the group's file, as its card's 「Open」 does (5-minute game ①).
   */
  get chatOpenableApps(): RailApp[] {
    return this.manifests.flatMap((manifest) => this.railApp(manifest.id) ?? this.chatFilesApp(manifest) ?? []);
  }

  /** An App that only opens a chat's files, as the group's list draws it: on, and not one gugu ships (those it places itself). */
  private chatFilesApp(manifest: ExtensionManifest): RailApp | null {
    const tab = manifest.contributes.tabs.find((candidate) => declaredContexts(candidate).includes('chat'));
    if (!tab || !this.isEnabled(manifest.id) || this.isPreinstalled(manifest.id)) return null;
    const name = localizedManifestText(manifest, this.locale).name;
    return { extensionId: manifest.id, name, kind: extensionTabKind(manifest.id, tab.name), iconDataUrl: this.appIcons[manifest.id] ?? null };
  }

  /** An App as the rail draws it, if the rail can open it: installed, on, with a page of its own. */
  private railApp(extensionId: string): RailApp | null {
    const main = this.mainTabOf(extensionId);
    // A preinstalled App is where the host puts it, not an App of the rail or a chat's App list besides (统筹 09-29, L3).
    if (!main || !main.enabled || main.preinstalled) return null;
    return { extensionId, name: main.extensionName, kind: main.kind, iconDataUrl: this.appIcons[extensionId] ?? null };
  }
}

const built = new WeakMap<InstalledExtensionsList, Map<string, InstalledApps>>();

/** The derivations of one list in one language, built once (a surface re-rendering gets the same object). */
export function appsOf(list: InstalledExtensionsList, locale: string): InstalledApps {
  let byLocale = built.get(list);
  if (!byLocale) built.set(list, (byLocale = new Map()));
  let apps = byLocale.get(locale);
  if (!apps) byLocale.set(locale, (apps = new InstalledApps(list, locale)));
  return apps;
}

/** What a host has installed, in the interface language. `null` host: nothing to read (unknown). */
export function useInstalledApps(hostKey: string | null): Reading<InstalledApps> {
  const reading = useReplica(installedExtensions, hostKey ? [hostKey] : null);
  const { resolvedLocale } = useLocale();
  return useMemo((): Reading<InstalledApps> => {
    if (reading.state === 'error') return reading;
    if (reading.state === 'unknown' || !reading.value.list) return { state: 'unknown' };
    return { state: 'value', value: appsOf(reading.value.list, resolvedLocale), stale: reading.stale, error: reading.error };
  }, [reading, resolvedLocale]);
}

/**
 * What a host has installed right now, for a one-moment decision outside rendering (a command, an open, a link): null
 * while it is not known. A caller that folds null into an answer says so with `@@@reading-default`.
 */
export function peekInstalledApps(hostKey: string = LOCAL_HOST): InstalledApps | null {
  const reading = installedExtensions.peek(hostKey);
  return reading.state === 'value' && reading.value.list ? appsOf(reading.value.list, getLocaleSnapshot().resolvedLocale) : null;
}

/** The list as it is now, or once it has been read (a command that must know). */
export async function fetchInstalledApps(hostKey: string = LOCAL_HOST): Promise<InstalledApps> {
  const now = peekInstalledApps(hostKey);
  if (now) return now;
  // A value restored from the snapshot (the dock only) is fresh by time but says nothing of what is installed: read it.
  if (installedExtensions.peek(hostKey).state === 'value') await installedExtensions.refresh(hostKey);
  const read = (await installedExtensions.fetch(hostKey)).list;
  if (!read) throw new Error('What is installed could not be read');
  return appsOf(read, getLocaleSnapshot().resolvedLocale);
}

// ── MobX readers (until PR 5 removes MobX): a tick that follows the local entry ───────────────────────────────────

const ticks = new Map<string, IObservableValue<number>>();

/**
 * For a MobX computed or reaction (a tab provider's title, the command registry, a session store) that reads what is
 * installed on a host: it re-runs when that entry changes or the language does. Holds no data of its own (the replica is
 * the only holder); one tick per host, fed by the model's own `subscribe`.
 */
export function peekInstalledAppsTracked(hostKey: string = LOCAL_HOST): InstalledApps | null {
  let tick = ticks.get(hostKey);
  if (!tick) {
    const box = observable.box(0);
    const bump = () => runInAction(() => box.set(box.get() + 1));
    installedExtensions.subscribe([hostKey], bump);
    // Names and titles are in the interface language: a switch re-runs them too.
    subscribeLocale(bump);
    ticks.set(hostKey, (tick = box));
  }
  tick.get();
  return peekInstalledApps(hostKey);
}

/** Every change of a host's entry (a value read or put): for a flow that diffs successive lists (tab registration). */
export function watchInstalled(hostKey: string, listener: (apps: InstalledApps | null) => void): () => void {
  return installedExtensions.subscribe([hostKey], () => listener(peekInstalledApps(hostKey)));
}

// ── writes: main's answer is put; a refusal reads the truth again (I4: ❌ put back what was there when it began) ──

function patchList(hostKey: string, patch: (list: InstalledExtensionsList) => InstalledExtensionsList) {
  return (old: InstalledReading | undefined): InstalledReading | undefined => (old?.list ? { ...old, list: patch(old.list) } : old);
}

/** Put a part of the list a write or a push said (bound to the entry when it began). */
export function putInstalled(hostKey: string, patch: (list: InstalledExtensionsList) => InstalledExtensionsList): void {
  installedExtensions.at(hostKey).set(patchList(hostKey, patch));
}

/** A whole list a host told (the phone's App store after each change). */
export function tellInstalled(hostKey: string, list: InstalledExtensionsList): void {
  installedExtensions.at(hostKey).set({ list });
}

/**
 * A write shown at once: `optimistic` is drawn on the click, `write` asks the host, `settled` puts its answer. A refused
 * write drops the optimistic part by reading the list again, and the refusal reaches the caller.
 */
export async function writeInstalled<R>(
  hostKey: string,
  optimistic: ((list: InstalledExtensionsList) => InstalledExtensionsList) | null,
  write: () => Promise<R>,
  settled: (answer: R) => (list: InstalledExtensionsList) => InstalledExtensionsList
): Promise<R> {
  const entry = installedExtensions.at(hostKey);
  if (optimistic) entry.set(patchList(hostKey, optimistic));
  try {
    const answer = await write();
    entry.set(patchList(hostKey, settled(answer)));
    return answer;
  } catch (error) {
    if (optimistic) void installedExtensions.refresh(hostKey);
    throw error;
  }
}

/** An App's 「自动更新」, as the host keeps it. Back on, main updates it at once; the list says so when it lands. */
export async function setAutoUpdate(hostKey: string, extensionId: string, on: boolean): Promise<void> {
  await writeInstalled(hostKey, null, async () => {
    const result = await extensionsApiOf(hostKey).setAutoUpdate({ extensionId, on });
    if (!result.success || !result.data) throw new Error(result.error ?? 'auto-update switch refused');
    return result.data.autoUpdateOff;
  }, (autoUpdateOff) => (list) => ({ ...list, autoUpdateOff }));
}

/** How an App's tools are offered to agents; drawn on the click, the host's answer kept. */
export async function setDisclosure(hostKey: string, extensionId: string, level: ExtensionDisclosureLevel): Promise<void> {
  const apps = peekInstalledApps(hostKey);
  if (!apps?.disclosure[extensionId]) throw new Error(`${extensionId} gives agents no tools`);
  await writeInstalled(hostKey, (list) => ({ ...list, disclosure: { ...list.disclosure, [extensionId]: level } }), async () => {
    const result = await extensionsApiOf(hostKey).setDisclosure({ extensionId, level });
    if (!result.success || !result.data) throw new Error(result.error ?? '');
    return result.data.level;
  }, (settledLevel) => (list) => ({ ...list, disclosure: { ...list.disclosure, [extensionId]: settledLevel } }));
}

/** A 「始终用它」 kept (or, `null`, let go — 摩擦单 F73) where the host keeps it too: this window reads it at once. */
export function noteOpenWithDefault(hostKey: string, key: string, tabKind: string | null): void {
  putInstalled(hostKey, (list) => {
    const { [key]: _dropped, ...rest } = list.openWith ?? {};
    return { ...list, openWith: tabKind === null ? rest : { ...rest, [key]: tabKind } };
  });
}

// ── what the market says of the installed Apps ───────────────────────────────────────────────────────────────────

/**
 * `offered`: the version the market gives this host for each App that has an update; `gone`: installed from the market
 * and no longer in it; `summary`: the whole answer (yanked, deprecated, fork behind, notes). The snapshot keeps the first
 * two (a row's 「更新到 vX」 on the first frame); `summary` absent = restored: the rest is not known yet.
 */
export type MarketUpdates = { offered: Record<string, string>; gone: string[]; summary?: MarketUpdatesSummary };

let phoneUpdates: (() => Promise<MarketUpdatesSummary>) | null = null;
export function definePhoneMarketUpdates(read: () => Promise<MarketUpdatesSummary>): void {
  phoneUpdates = read;
}

async function readUpdates(hostKey: string): Promise<MarketUpdatesSummary> {
  if (hostKey === PHONE_HOST) {
    if (!phoneUpdates) throw new Error('The phone App store is not loaded');
    return phoneUpdates();
  }
  const result = await extensionsApiOf(hostKey).marketUpdates();
  if (!result.success || !result.data) throw new Error(result.error ?? 'update check failed');
  return result.data;
}

/**
 * What the market says of a host's installed Apps (#5410; absorbs the phone's `offeredVersions`). Host push: main's
 * `marketRefreshedChannel` (outcome `changed`) and the phone's `market.onRefreshed`, and a change of what is installed,
 * `refresh` it (wire-market-refresh.ts, phoneApps.ts). ❌ polled.
 */
export const marketUpdates = replica({
  name: 'marketUpdates',
  scope: 'device',
  read: async (_owner: string, hostKey: string): Promise<MarketUpdates> => {
    const summary = await readUpdates(hostKey);
    return { offered: Object.fromEntries(Object.entries(summary.updates).map(([id, update]) => [id, update.version])), gone: summary.gone ?? [], summary };
  },
  fresh: Infinity,
  // Grows with the Apps installed from the market here (C1-C3 table: kept at 1,024): ids and versions only.
  persist: {
    maxBytes: 1024,
    maxEntries: 1,
    carry: (value: MarketUpdates, hostKey: string) => (hostKey.startsWith('remote:') ? undefined : value.summary ? { offered: value.offered, gone: value.gone } : value),
  },
});

/**
 * The number on the 「App」 badge: the Apps with an update (switched on), a yanked or deprecated version — each once. Not
 * updated by itself (pinned to an older version) still counts (owner 10-19「对齐 vscode」).
 */
export function updateCountOf(summary: MarketUpdatesSummary, apps: InstalledApps): number {
  return new Set<string>([
    ...Object.keys(summary.updates).filter((id) => apps.isEnabled(id)),
    ...Object.keys(summary.forkBehind ?? {}).filter((id) => apps.isEnabled(id)),
    ...Object.keys(summary.yanked),
    ...Object.keys(summary.deprecated),
  ]).size;
}
