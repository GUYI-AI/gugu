import { alignSessionProjectReferences, referencedSessionIds, type SessionProjectLocation } from '@shared/core/projects/session-project-references';
import { appState } from '@renderer/lib/stores/app-state';
import { screenLayout } from '@renderer/app/screen-layout';
import { readSavedScreen, writeSavedScreen } from '@renderer/app/screen-layout-actions';
import type { ScreenLayoutSnapshot } from '@renderer/app/screen-layout';

/** The host repairs its view-state KV during migration; only saved renderer references need querying. */
export function savedScreenSessionIds(): string[] {
  return referencedSessionIds(readSavedScreen());
}

function alignSavedScreen(locations: readonly SessionProjectLocation[]): void {
  const prior = readSavedScreen(), next = alignSessionProjectReferences(prior, locations);
  if (next !== prior) writeSavedScreen(next as ScreenLayoutSnapshot | null);
}

/** The host already repaired navigation/view-state KV; the renderer owns only its saved screen. */
export function restoreSavedScreenSessionLocations(locations: readonly SessionProjectLocation[]): void {
  alignSavedScreen(locations);
}

/** A remote directory changed: update references before the old project is removed and guards revalidate. */
export function reconcileSessionProjectLocations(locations: readonly SessionProjectLocation[]): void {
  if (!locations.length) return;
  const current = appState.navigation.viewParamsStore.session;
  const next = alignSessionProjectReferences(current, locations);
  if (next && next !== current) appState.navigation.updateViewParams('session', next);
  const screen = screenLayout.snapshot, aligned = alignSessionProjectReferences(screen, locations);
  if (aligned && aligned !== screen) screenLayout.restore(aligned);
  alignSavedScreen(locations);
}
