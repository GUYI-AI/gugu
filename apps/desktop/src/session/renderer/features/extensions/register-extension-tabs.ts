import { log } from '@renderer/utils/logger';
import { sessionTabRegistry } from '@renderer/features/sessions/session-tab-registry';
import { createExtensionTabProvider } from './extension-tab-provider';
import { installedExtensions, marketUpdates, peekInstalledApps, watchInstalled, LOCAL_HOST, type InstalledApps } from './installed-extensions';
import { extensionTabKind, type ExtensionManifest } from '@shared/extensions/manifest';

/**
 * The tab providers follow what is installed here (a flow over the `installedExtensions('local')` replica, diffing each
 * value with the one before): a newly installed or switched-on App's tabs register, a switched-off one's close and
 * withdraw, an uninstalled one's withdraw (its open tabs fall back to the 「未加载」 placeholder). Off the critical path: a
 * tab whose provider is missing is held as a placeholder and promoted in place when it registers (PaneStore). Refs #2374.
 */
let followed: Map<string, { manifest: ExtensionManifest; enabled: boolean }> | null = null;

function follow(apps: InstalledApps | null): void {
  // A value restored from the snapshot (the dock only) or an entry dropped says nothing about what is installed.
  if (!apps) return;
  const before = followed;
  followed = new Map(apps.manifests.map((manifest) => [manifest.id, { manifest, enabled: apps.isEnabled(manifest.id) }]));
  for (const manifest of apps.manifests) {
    const enabled = apps.isEnabled(manifest.id);
    // Switched-off extensions stay listed but are not offered: no provider, so their tabs hold as the placeholder (#5265).
    if (enabled) registerExtensionTabs(manifest);
    else if (before?.get(manifest.id)?.enabled) {
      unregisterExtensionTabs(manifest.id, manifest.contributes.tabs.map((tab) => tab.name), { closeOpenTabs: true });
    }
  }
  for (const [id, { manifest }] of before ?? []) {
    if (followed.has(id)) continue;
    unregisterExtensionTabs(id, manifest.contributes.tabs.map((tab) => tab.name));
  }
}

let stopFollowing: (() => void) | null = null;

function ensureFollowing(): void {
  if (stopFollowing) return;
  const stop = watchInstalled(LOCAL_HOST, follow);
  stopFollowing = () => { stop(); stopFollowing = null; followed = null; };
  follow(peekInstalledApps(LOCAL_HOST));
}

/** Start following (once per window), then read the list: the snapshot kept only the dock. */
export function wireInstalledExtensionTabs(): () => void {
  ensureFollowing();
  void registerInstalledExtensionTabs().catch((error: unknown) => log.warn('Installed extensions could not be read:', error));
  return () => stopFollowing?.();
}

/** Read what is installed here again (an install, an uninstall, a switch): the tabs follow the value it puts. */
export async function registerInstalledExtensionTabs(): Promise<void> {
  ensureFollowing();
  // Marked stale first, then read whether or not a surface shows it (a refresh alone reads only where shown).
  await installedExtensions.refresh(LOCAL_HOST);
  await installedExtensions.fetch(LOCAL_HOST);
}

/**
 * #6264 这台机器上装着的扩展被**别的桌面**改了(资源库切到这台机器后装 / 卸 / 开关):重读清单,tab 跟着值走(`follow`);
 * 市场对装着的这些要说的话一起重读。
 */
export async function resyncInstalledExtensionTabs(): Promise<void> {
  await registerInstalledExtensionTabs();
  void marketUpdates.refresh(LOCAL_HOST);
}

/** Registers every tab one extension contributes — on install, and on switching it back on. */
export function registerExtensionTabs(manifest: ExtensionManifest): void {
  for (const contribution of manifest.contributes.tabs) {
    registerExtensionTabProvider(manifest.id, contribution.name);
  }
}

/**
 * Withdraws the tab providers an extension contributed, after it is uninstalled.
 *
 * Open tabs are not closed — the user did not close them — but they fall back to the
 *「未加载」placeholder, and the uninstalled extension's surface is torn down with the
 * resource. Leaving it registered would let a just-removed extension keep drawing
 * (and keep its webview alive) until the next restart, which is precisely the state a
 * user who uninstalls something they stopped trusting is trying to leave.
 *
 * Reinstalling re-registers the same kinds, and PaneStore promotes those very tabs
 * back in place. Refs #2374.
 */
export function unregisterExtensionTabs(
  extensionId: string,
  tabNames: readonly string[],
  options: {
    /**
     * Close the tabs first instead of leaving placeholders. For a disable the
     * user asked for from the panel: "stop showing it" must not leave litter
     * behind (owner, #5265). Uninstall keeps the placeholder rule above.
     */
    closeOpenTabs?: boolean;
  } = {}
): void {
  for (const tabName of tabNames) {
    const kind = extensionTabKind(extensionId, tabName);
    if (options.closeOpenTabs) sessionTabRegistry.closeKind(kind);
    sessionTabRegistry.unregister(kind);
  }
}

/**
 * Registers one contribution, tolerating a kind that is already registered.
 * Reinstalling an extension re-runs this while its providers are still live: the
 * existing provider stays and the tabs open against it keep working, and since
 * providers read their title from the replica rather than a captured manifest, a
 * renamed tab still updates.
 */
function registerExtensionTabProvider(extensionId: string, tabName: string): void {
  const provider = createExtensionTabProvider(extensionId, tabName);
  if (sessionTabRegistry.has(provider.kind)) return;
  try {
    sessionTabRegistry.register(provider);
  } catch (error) {
    log.warn(`Failed to register extension tab provider ${provider.kind}:`, error);
  }
}
