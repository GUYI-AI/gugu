import {
  configureExtensionSession,
  isExtensionSessionConfigured,
  reloadExtensionSurfaces,
} from '@main/core/extensions/extension-session';
import { extensionsService } from '@main/core/extensions/extensions-root';
import {
  stopExtensionBackground,
  syncExtensionBackgrounds,
} from '@main/core/extensions/extension-background';
import { retireExtensionPrograms } from '@main/core/extensions/extension-programs';
import { notifyInstalledAppsChanged } from '@main/core/extensions/extension-bridge';
import { log } from '@main/lib/logger';
import type { AppCredentialDeclaration } from '@shared/extensions/app-credentials';

/**
 * What has to happen once a bundle's files are in place — whoever installed it.
 *
 * One function because there are two install paths (Settings, and an agent's
 * `app_install`) and they must leave the app in the same state. They did not:
 * the agent path skipped all of this, so an extension an agent installed had no
 * background page — its tools answered "no running background page" — and an
 * upgrade an agent installed kept serving the previous version. Refs #6387.
 */
export function applyInstalledExtension(installed: { manifest: { id: string; apiVersion?: number; permissions?: { network?: readonly string[]; credentials?: AppCredentialDeclaration[] } }; rootDir: string; manifestDigest?: string }): void {
  const id = installed.manifest.id;
  // The saved credentials the person picked in this install's sheet become the App's, bound to the code just installed.
  if (installed.manifestDigest && installed.manifest.permissions?.credentials?.length) {
    const installedWithDigest = { ...installed, manifestDigest: installed.manifestDigest };
    void import('@main/core/extensions/app-credentials').then(({ applyStagedCredentialChoices }) => applyStagedCredentialChoices(installedWithDigest)).catch((error: unknown) => {
      log.warn('The credentials picked at install could not be given to the App', { extensionId: id, error: error instanceof Error ? error.message : String(error) });
    });
  }
  // An upgrade replaces the files under a session that is already serving
  // them. Without this, a tab that is open right now keeps enforcing the
  // previous version's host list and being served its CSP — including when
  // the new version *narrows* what it asks for. Only for a session that
  // already exists: a fresh install is hardened when its surface activates.
  if (isExtensionSessionConfigured(id)) {
    configureExtensionSession({
      extensionId: id,
      apiVersion: installed.manifest.apiVersion,
      rootDir: installed.rootDir,
      networkHosts: extensionsService().grantedHosts(id),
      declaredHosts: installed.manifest.permissions?.network ?? [],
    });
    // Same reason as a revoke, plus one more: the files behind the surface
    // were just replaced, so what it is running is the previous version.
    reloadExtensionSurfaces(id);
  }
  // 升版时后台跑的还是上一版的文件 —— 与 reloadExtensionSurfaces 同一个理由,
  // 只是后台没有「可见的面」提醒任何人它旧了,所以更要在这里换掉。首次安装则是在这里拉起。
  stopExtensionBackground(id);
  syncExtensionBackgrounds();
  // #6615 升级立即对所有会话生效:旧版程序退出池子,下一次调用(不论哪条会话)起新版。
  void retireExtensionPrograms(id).catch(error => {
    log.warn('Extension program retirement failed after install', { extensionId: id, error });
  });
  // 摩擦单 F87: the files it claims open with it now — open group pages list again, and show so at once.
  void notifyInstalledAppsChanged();
}
