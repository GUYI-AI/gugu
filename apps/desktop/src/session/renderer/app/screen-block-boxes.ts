import type { RefObject } from 'react';
import { surfaceHost } from '@renderer/lib/layout/place-in';

/**
 * The screen's session pages' hosts (@@@placed-surface): a block showing a session puts its host in its box; else it is
 * in the park, the screen's own box.
 */
export const sessionPageHosts = new Map<string, HTMLDivElement>();
export const sessionPageHost = (sessionId: string) =>
  sessionPageHosts.get(sessionId) ?? sessionPageHosts.set(sessionId, surfaceHost('contents')).get(sessionId)!;
export const screenPark: RefObject<HTMLElement | null> = { current: null };
