import { replicaAccount } from '@/lib/replica';
import { readViewState, takeLegacyLocalStorage, writeViewState, type ViewPanel } from '@/lib/viewStateTable';

export type TabPlacement = 'separate' | 'beside';
export interface TabPlacementMemory {
  read(resourceId: string): TabPlacement | undefined;
  write(resourceId: string, placement: TabPlacement): void;
}

// Where each resource last opened, per account: view state (lib/viewStateTable), the most recently placed ones that fit
// in BYTES (a resource id carries its path, so a count would not bound it). Kept in localStorage before
// (`gugu.tab-placement.v1:<account>`); moved over once.
const BYTES = 2800;
/** The newest placements that fit: the oldest go first. */
function fitting(placements: Record<string, TabPlacement>): Record<string, TabPlacement> {
  const entries = Object.entries(placements);
  while (entries.length && JSON.stringify({ placements: Object.fromEntries(entries) }).length > BYTES) entries.shift();
  return Object.fromEntries(entries);
}
type Stored = { placements: Record<string, TabPlacement> };
const placementOf = (account: string): ViewPanel => ({ conversation: '', panel: 'tab-placement', account });
const LEGACY_PREFIX = 'gugu.tab-placement.v1:';
takeLegacyLocalStorage((key) => key.startsWith(LEGACY_PREFIX), (key, raw) => {
  const value: unknown = JSON.parse(raw);
  const placements = Object.fromEntries(Object.entries(value !== null && typeof value === 'object' ? value : {})
    .filter((entry): entry is [string, TabPlacement] => entry[1] === 'separate' || entry[1] === 'beside')
  );
  writeViewState<Stored>(placementOf(key.slice(LEGACY_PREFIX.length)), { placements: fitting(placements) });
});

/** Read on a user's open/close, never on startup; no account (signed out) keeps nothing. */
export function accountTabPlacementMemory(account: () => string | null | undefined = () => replicaAccount().id): TabPlacementMemory {
  return {
    read(resourceId) {
      const id = account();
      return id ? readViewState<Stored>(placementOf(id)).placements?.[resourceId] : undefined;
    },
    write(resourceId, placement) {
      const id = account();
      if (!id) return;
      const placements = { ...readViewState<Stored>(placementOf(id)).placements };
      delete placements[resourceId];
      placements[resourceId] = placement;
      writeViewState<Stored>(placementOf(id), { placements: fitting(placements) });
    },
  };
}
