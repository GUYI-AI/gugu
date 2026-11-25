import type { CreationFastGroup } from '@shared/core/agents/create-fast-mode';
import { getPlatformModelCatalogResolver } from './platform-model-catalog-hook';

export function platformFastGroup(model: string, supported: boolean): CreationFastGroup | null {
  return supported
    ? { model, selected: 'off', available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] }
    : null;
}

/** The same capability used by the picker and checked again when signing the ticket. */
export async function platformCreationFastGroup(provider: string, model: string,
  surface: 'acp' | 'tui'): Promise<CreationFastGroup | null> {
  if (provider !== 'codex' || !model.startsWith('platform:')) return null;
  const snapshot = await getPlatformModelCatalogResolver()?.({ providerId: provider, surface });
  const selected = snapshot?.models.find((row) => row.id === model.slice('platform:'.length));
  return platformFastGroup(model, selected?.fastSupported === true && !selected.requiresMembership);
}
