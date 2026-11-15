import { userIdFromSupabaseAccessToken } from '@gugu/core';
import type { AppResourceEvent } from '@shared/extensions/agent-resources';
import { currentAccountAccessToken } from './account-token';
import { extensionsService } from './extensions-root';

/**
 * #1927 (42) Who hears that the agent resources of their binding changed (`gugu.bindings.onResourcesChanged`): one entry
 * per page and watch, holding the authority it was granted under — account, installed App, binding name, chosen
 * conversation (`handle`) and the agent found for it. That authority is checked again before each event and whenever the
 * service says a grant, enablement, install or choice changed; once it no longer holds the entry is gone and the page hears
 * `ended`. Torn down with its page too (`stopPageWatches`). Nothing here reads the store: a page hearing `changed` reads
 * again, and that read checks everything anew.
 */
export interface ResourceWatch {
  pageId: number;
  watchId: string;
  extensionId: string;
  name: string;
  ownerId: string;
  handle: string;
  agentId: string;
  hear(event: AppResourceEvent): void;
}

const watches = new Map<number, Map<string, ResourceWatch>>();
let stopHearingService: (() => void) | null = null;

function all(): ResourceWatch[] {
  return [...watches.values()].flatMap((page) => [...page.values()]);
}

function forget(watch: ResourceWatch): boolean {
  const page = watches.get(watch.pageId);
  if (page?.get(watch.watchId) !== watch) return false;
  page.delete(watch.watchId);
  if (page.size === 0) watches.delete(watch.pageId);
  if (watches.size === 0) {
    stopHearingService?.();
    stopHearingService = null;
  }
  return true;
}

/** The grant it was made under still holds: installed, enabled, `chat:resources` granted, the same chosen conversation. */
function holds(watch: ResourceWatch): boolean {
  try {
    return extensionsService().conversationBinding(watch.ownerId, watch.extensionId, watch.name, 'resources')?.handle === watch.handle;
  } catch {
    return false;
  }
}

async function signedIn(): Promise<string | null> {
  const token = await currentAccountAccessToken().catch(() => null);
  return token ? userIdFromSupabaseAccessToken(token) : null;
}

function end(watch: ResourceWatch): void {
  if (forget(watch)) watch.hear({ name: watch.name, state: 'ended' });
}

/** Check every watch `which` picks again; those whose authority went end. */
export async function revalidateResourceWatches(which: (watch: ResourceWatch) => boolean = () => true): Promise<void> {
  const owner = await signedIn();
  for (const watch of all()) if (which(watch) && (owner !== watch.ownerId || !holds(watch))) end(watch);
}

/**
 * Held from now on, if its grant still holds at this very moment (checked after it is listening, so a change between the
 * caller's last check and here is not missed). False: not held.
 */
export function addResourceWatch(watch: ResourceWatch): boolean {
  const previous = watches.get(watch.pageId)?.get(watch.watchId);
  if (previous) forget(previous);
  let page = watches.get(watch.pageId);
  if (!page) watches.set(watch.pageId, page = new Map());
  page.set(watch.watchId, watch);
  stopHearingService ??= extensionsService().onBindingAuthorityChanged((extensionId) => {
    void revalidateResourceWatches((held) => held.extensionId === extensionId);
  });
  if (holds(watch)) return true;
  forget(watch);
  return false;
}

/** The page stopped this watch itself: nothing to tell it. */
export function stopResourceWatch(pageId: number, watchId: string): void {
  const watch = watches.get(pageId)?.get(watchId);
  if (watch) forget(watch);
}

/** The page went (navigated, closed, unbound). */
export function stopResourceWatches(pageId: number): void {
  for (const watch of [...watches.get(pageId)?.values() ?? []]) forget(watch);
}

/**
 * The account's event bus said these agents' resources changed (`assistant_panel_changed`), or — `'all'` — it joined
 * again, or the signed-in account changed: whatever was missed, read again. Each watch still holding its authority hears
 * `changed`; the others end.
 */
export async function notifyAgentResourcesChanged(agentIds: readonly string[] | 'all'): Promise<void> {
  const owner = await signedIn();
  for (const watch of all()) {
    if (agentIds !== 'all' && !agentIds.includes(watch.agentId)) continue;
    if (owner !== watch.ownerId || !holds(watch)) end(watch);
    else watch.hear({ name: watch.name, state: 'changed' });
  }
}

/** Test seam: how many watches are held. */
export function heldResourceWatches(): number {
  return all().length;
}
