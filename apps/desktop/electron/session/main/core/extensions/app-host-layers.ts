import { appHostLayerReportSchema, type AppHostLayerShown } from '@shared/extensions/app-host-layer';

/**
 * #1925 (API 46) The host page drawn over each App's panel now, as the trusted window says it draws it (`reportHostLayer`,
 * never an App), with the account it was opened for: what `panel.hostPage` (`gugu.bindings.surface`) and `open`
 * (`gugu.bindings.work`) are answered from. One per App; a report replaces the one before. Believed only for the account
 * asking: another account's layer is no layer.
 */
const layers = new Map<string, AppHostLayerShown>();

/** The layer over this App's panel, if it was opened for `ownerId`. */
export function hostLayerOf(extensionId: string, ownerId: string): AppHostLayerShown | null {
  const layer = layers.get(extensionId);
  return layer && layer.ownerId === ownerId ? layer : null;
}

/** Trusted window only (controller `reportHostLayer`). True when what the App's pages hear may have changed. */
export function reportHostLayer(input: unknown): boolean {
  const parsed = appHostLayerReportSchema.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error('Not a report of a host page over an App\'s panel'), { code: 'invalid' });
  const { extensionId, layer } = parsed.data;
  const before = layers.get(extensionId);
  if (!layer) {
    if (!before) return false;
    layers.delete(extensionId);
    return true;
  }
  if (before && JSON.stringify(before) === JSON.stringify(layer)) return false;
  layers.set(extensionId, layer);
  return true;
}

/** Tests only: a window that draws no host page anywhere. */
export function forgetHostLayersForTest(): void {
  layers.clear();
}
