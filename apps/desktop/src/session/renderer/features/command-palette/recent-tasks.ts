import { replicaAccount } from '@/lib/replica';
import { readViewState, takeLegacyLocalStorage, writeViewState, type ViewPanel } from '@/lib/viewStateTable';

// Desktop-local navigation history per account: view state (lib/viewStateTable). Kept in localStorage before
// (`gugu:recent-tasks:<account>`); moved over once.
const LEGACY_PREFIX = 'gugu:recent-tasks:';
const recentOf = (owner: string): ViewPanel => ({ conversation: '', panel: 'recent-tasks', account: owner });
const tidy = (ids: unknown): string[] => Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))].slice(0, 20) : [];
takeLegacyLocalStorage((key) => key.startsWith(LEGACY_PREFIX), (key, raw) => writeViewState(recentOf(key.slice(LEGACY_PREFIX.length)), { ids: tidy(JSON.parse(raw)) }));

export function recentTaskIds(owner = replicaAccount().id): string[] {
  return owner ? tidy(readViewState<{ ids: string[] }>(recentOf(owner)).ids) : [];
}

/** Desktop-local navigation history; never changes a task's shared interaction time. */
export function rememberTask(id: string, archived = false, owner = replicaAccount().id): void {
  if (!owner) return;
  const rest = recentTaskIds(owner).filter((item) => item !== id);
  writeViewState(recentOf(owner), { ids: (archived ? rest : [id, ...rest]).slice(0, 20) });
}
