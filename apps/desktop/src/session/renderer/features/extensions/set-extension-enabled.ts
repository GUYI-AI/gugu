import type { ExtensionManifest } from '@shared/extensions/manifest';
import { LOCAL_EXTENSIONS_HOST, type ExtensionsHost } from './extensions-host';
import { writeInstalled } from './installed-extensions';

/**
 * Switch an installed extension off or on — the rung between installed and uninstalled (owner, #5265: 可用/不可用). One
 * function for both places that offer the switch (the workspace panel and Settings → Extensions).
 *
 * Drawn on the click; the host's answer is what stays, and a refused write reads the list again (I4) and throws so the
 * caller can say so with a way to retry. The tab providers follow the list (register-extension-tabs.ts `follow`): off
 * closes its open tabs and withdraws the providers, on registers them again. Another desktop's tabs follow in its own window.
 */
export async function setExtensionEnabled(
  manifest: ExtensionManifest,
  enabled: boolean,
  /** 资源库看的是另一台咕咕桌面时(#6264):开关的是那台机器上的,tab 由它自己的窗口跟进。 */
  host: ExtensionsHost = LOCAL_EXTENSIONS_HOST
): Promise<void> {
  // Switching off here closes its open tabs (the providers follow the list): only once main agreed, ❌ on the click.
  const drawnAtOnce = enabled || !host.local;
  await writeInstalled(
    host.key,
    drawnAtOnce ? (list) => {
      const before = list.disabled ?? [];
      return { ...list, disabled: enabled ? before.filter((id) => id !== manifest.id) : [...new Set([...before, manifest.id])] };
    } : null,
    async () => {
      const result = await host.api.setEnabled({ extensionId: manifest.id, enabled });
      if (!result.success || !result.data) throw new Error(result.error ?? '');
      return result.data.disabled;
    },
    (disabled) => (list) => ({ ...list, disabled })
  );
}
