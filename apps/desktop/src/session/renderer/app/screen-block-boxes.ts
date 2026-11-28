import type { RefObject } from 'react';
import { surfaceHost } from '@renderer/lib/layout/place-in';

/** Session pages' hosts (@@@placed-surface): in the box of a block showing it, else in the park (the screen's box). */
export const sessionPageHosts = new Map<string, HTMLDivElement>();
export const sessionPageHost = (sessionId: string) =>
  sessionPageHosts.get(sessionId) ?? sessionPageHosts.set(sessionId, surfaceHost('contents')).get(sessionId)!;
export const screenPark: RefObject<HTMLElement | null> = { current: null };
