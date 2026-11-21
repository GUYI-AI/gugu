import type { InstalledSection } from '@renderer/features/extensions/installed/installed-item';
import type { InventoryView } from '@renderer/features/extensions/installed/InstalledItems';
import { appState } from '@renderer/lib/stores/app-state';

export type AppsTab = 'agents' | 'market' | 'connectors';
export type AppsSort = 'recommended' | 'newest' | 'popular';

/**
 * Where you are on the Apps page, the one source for it: the Apps view's `location` param (apps-views). It is a place
 * param (view-registry `placeParams`), so every move to another place is a step of the back stack and leaving a page
 * is going back; it is remembered across leaving the view and restarts, so opening Apps plainly returns here.
 */
export type AppsLocation = {
  tab: AppsTab;
  /** Another desktop of this account whose Apps are shown (an App link naming it); absent = this computer. */
  deviceId?: string;
  /** The Apps tab's order. */
  sort?: AppsSort;
  /** How far down the list was when it was left for an App's page. */
  scroll?: number;
  /**
   * The Installed sheet, open on one segment of one device. `direct`: opened straight onto connector management (the
   * shell's "manage connectors"), which shows its management controls at once.
   */
  installed?: { section: InstalledSection; deviceId?: string; layout?: InventoryView; scroll?: number; direct?: boolean };
  /**
   * An App's page: its settings (`manage`) or its market page. Without `page` (a link) the page decides by whether it
   * is installed. `fromApp`: opened from that App's own tab, so its back button is named after the App.
   */
  detail?: { page?: 'manage' | 'market'; extensionId: string; variant?: string; fromApp?: boolean };
};

export const APPS_HOME: AppsLocation = { tab: 'agents' };

export function appsLocation(params: { location?: AppsLocation } | undefined): AppsLocation {
  return params?.location ?? APPS_HOME;
}

/** The location you are at now on the Apps page (the remembered one when you are elsewhere). */
export function currentAppsLocation(): AppsLocation {
  return appsLocation(appState.navigation.viewParamsStore.apps);
}

/** Go to a place on the Apps page: a new step of the back stack. */
export function openAppsLocation(location: AppsLocation): void {
  appState.navigation.navigate('apps', { location });
}

/** Change where you are without a new step (a segment switched, a scroll recorded): the step you are on follows. */
export function moveAppsLocation(update: (location: AppsLocation) => AppsLocation): void {
  appState.navigation.updateViewParams('apps', (params) => ({ ...params, location: update(appsLocation(params)) }));
}

const onApps = (entry: (typeof appState.history.entries)[number] | undefined) => entry?.kind === 'view' && entry.viewId === 'apps';

/** The place one step back, when this step and that one are both on the Apps page (what a page's back button returns to). */
export function previousAppsLocation(): AppsLocation | null {
  const { entries, index } = appState.history;
  const previous = entries[index - 1];
  return onApps(entries[index]) && previous?.kind === 'view' && onApps(previous) ? appsLocation(previous.params as { location?: AppsLocation }) : null;
}
