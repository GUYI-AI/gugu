import type { ContentMenuEntry } from './content-context-menu';

export type LinkMenuAction = 'open-link' | 'open-link-system' | 'copy-link';
export interface LinkMenuLabels { openInApp: string; openInSystem: string; copyLink: string }

/** A link the link menu is for: a web page (other schemes keep the surface's own handling). */
export function isWebLink(url: string | null | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url.trim());
}

/**
 * @@@link-menu — the one set of rows a right-clicked web link offers, in every menu that has a link under the pointer
 * (chat and task messages, file previews, App pages, terminals, the in-app browser's own pages): open it in Gugu's
 * browser, open it in the system browser, copy it. The message menu draws the same rows in the same order
 * (components/chat/messageActionItems.ts). Each surface says what "open in Gugu's browser" means for it.
 */
export function linkMenuEntries(labels: LinkMenuLabels, run: (action: LinkMenuAction) => void | Promise<void>): ContentMenuEntry[] {
  return [
    { id: 'open-link', label: labels.openInApp, click: () => run('open-link') },
    { id: 'open-link-system', label: labels.openInSystem, click: () => run('open-link-system') },
    { id: 'copy-link', label: labels.copyLink, click: () => run('copy-link') },
  ];
}
