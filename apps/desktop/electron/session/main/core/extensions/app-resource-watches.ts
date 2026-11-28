import { userIdFromSupabaseAccessToken } from '@gugu/core';
import type { AppResourceEvent } from '@shared/extensions/agent-resources';
import { log } from '@main/lib/logger';
import { currentAccountAccessToken } from './account-token';
import { extensionsService } from './extensions-root';

/**
 * #1927 (42) Who hears that the agent resources of their binding changed (`gugu.bindings.onResourcesChanged`): one entry
 * per page and watch, holding the authority it was granted under — account, installed App, binding name, chosen
 * conversation (`handle`) and the agent found for it. That authority is checked again before each event and whenever the
 * service says a grant, enablement, install or choice changed; once it no longer holds the entry is gone and the page hears
 * `ended`. Torn down with its page too (`stopPageWatches`). Each entry also follows where the assistant lives (`rehome`):
 * its files are heard only while that is this computer. Nothing here reads the store: a page hearing `changed` reads again,
 * and that read checks everything anew.
 */
export interface ResourceWatch {
  pageId: number;
  watchId: string;
  extensionId: string;
  name: string;
  ownerId: string;
  handle: string;
  agentId: string;
  lifetime: AbortController;
  hear(event: AppResourceEvent): void;
  /** Finds the assistant's home again under the same authority (`denied` thrown if it no longer holds); true: it moved. */
  rehome(): Promise<boolean>;
}

const watches = new Map<number, Map<string, ResourceWatch>>();
let stopHearingService: (() => void) | null = null;

function all(): ResourceWatch[] {
  return [...watches.values()].flatMap((page) => [...page.values()]);
}

export function forgetResourceWatch(watch: ResourceWatch): boolean {
  const page = watches.get(watch.pageId);
  if (page?.get(watch.watchId) !== watch) return false;
  page.delete(watch.watchId);
  watch.lifetime.abort();
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
  if (forgetResourceWatch(watch)) watch.hear({ name: watch.name, state: 'ended' });
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
  if (previous) forgetResourceWatch(previous);
  let page = watches.get(watch.pageId);
  if (!page) watches.set(watch.pageId, page = new Map());
  page.set(watch.watchId, watch);
  stopHearingService ??= extensionsService().onBindingAuthorityChanged((extensionId) => {
    void revalidateResourceWatches((held) => held.extensionId === extensionId);
  });
  if (holds(watch)) return true;
  forgetResourceWatch(watch);
  return false;
}

/** The page stopped this watch itself: nothing to tell it. */
export function stopResourceWatch(pageId: number, watchId: string): void {
  const watch = watches.get(pageId)?.get(watchId);
  if (watch) forgetResourceWatch(watch);
}

/** The page went (navigated, closed, unbound). */
export function stopResourceWatches(pageId: number): void {
  for (const watch of [...watches.get(pageId)?.values() ?? []]) forgetResourceWatch(watch);
}

function notify(watch: ResourceWatch, owner: string | null): void {
  if (watch.lifetime.signal.aborted) return;
  if (owner !== watch.ownerId || !holds(watch)) end(watch);
  else watch.hear({ name: watch.name, state: 'changed' });
}

/** A workspace change belongs to the page that subscribed to the home. */
export async function notifyResourceWatch(watch: ResourceWatch): Promise<void> {
  notify(watch, await signedIn());
}

export async function notifyAgentResourcesChanged(agentIds: readonly string[]): Promise<void> {
  const held = all().filter(watch => agentIds.includes(watch.agentId));
  if (!held.length) return;
  const owner = await signedIn();
  for (const watch of held) notify(watch, owner);
}

/**
 * The account signed in, or where its assistant lives, may have changed while pages stay open: watches whose authority
 * went end; the others find the assistant's home again and, where it moved, hear `changed`. A check that could not be
 * made now keeps the watch as it is.
 */
export async function rehomeResourceWatches(): Promise<void> {
  await revalidateResourceWatches();
  await Promise.all(all().map(async (watch) => {
    try {
      if (await watch.rehome()) await notifyResourceWatch(watch);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'denied') end(watch);
      else log.warn('Finding the assistant home of an App resource watch failed', { error: String(error) });
    }
  }));
}

/** Test seam: how many watches are held. */
export function heldResourceWatches(): number {
  return all().length;
}
