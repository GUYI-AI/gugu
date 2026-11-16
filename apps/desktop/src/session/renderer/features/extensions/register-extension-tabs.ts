import { log } from '@renderer/utils/logger';
import { sessionTabRegistry } from '@renderer/features/sessions/session-tab-registry';
import { createExtensionTabProvider } from './extension-tab-provider';
import { installedExtensions, marketUpdates, peekInstalledApps, watchInstalled, LOCAL_HOST, type InstalledApps } from './installed-extensions';
import { extensionTabKind, type ExtensionManifest } from '@shared/extensions/manifest';

// The tab providers follow what is installed here (a flow diffing each value with the one before). Refs #2374.
let followed: Map<string, { manifest: ExtensionManifest; enabled: boolean }> | null = null;

function follow(apps: InstalledApps | null): void {
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

export function wireInstalledExtensionTabs(): () => void {
  ensureFollowing();
  void registerInstalledExtensionTabs().catch((error: unknown) => log.warn('Installed extensions could not be read:', error));
  return () => stopFollowing?.();
}

export async function registerInstalledExtensionTabs(): Promise<void> {
  ensureFollowing();
  await installedExtensions.refresh(LOCAL_HOST);
  await installedExtensions.fetch(LOCAL_HOST);
}

/** #6264 Another desktop changed what is installed here. */
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

/** Tolerates a kind already registered: a reinstall keeps the live provider and its open tabs. */
function registerExtensionTabProvider(extensionId: string, tabName: string): void {
  const provider = createExtensionTabProvider(extensionId, tabName);
  if (sessionTabRegistry.has(provider.kind)) return;
  try {
    sessionTabRegistry.register(provider);
  } catch (error) {
    log.warn(`Failed to register extension tab provider ${provider.kind}:`, error);
  }
}
