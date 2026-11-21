import type { ExtensionManifest } from '@shared/extensions/manifest';
import { LOCAL_EXTENSIONS_HOST, type ExtensionsHost } from './extensions-host';
import { writeInstalled } from './installed-extensions';

/** Switch an installed extension off or on (owner, #5265: 可用/不可用); a refusal throws for the caller to say. */
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
