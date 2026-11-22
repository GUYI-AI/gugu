import { clipboard } from 'electron';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { ContentMenuEntry } from '@shared/content-context-menu';
import { browserLinkCopiedChannel } from '@shared/events/browserEvents';
import { isExternalHttpUrl } from './browser-window-open';

export type BrowserMenuContext = {
  selectionText: string;
  linkURL: string;
  srcURL: string;
  mediaType: string;
};

export function copyTextThenNotify(text: string, onCopied?: () => void): void {
  void clipboard.writeText(text).then(
    () => onCopied?.(),
    (error: unknown) => { log.error('clipboard.writeText failed', { error: String(error) }); },
  );
}

export function browserContextMenuItems(context: BrowserMenuContext, actions: {
  open(url: string): void | Promise<void>;
  openTab(url: string): void | Promise<void>;
  reload(): void | Promise<void>;
}): ContentMenuEntry[] {
  const selected = context.selectionText?.trim();
  const image = context.mediaType === 'image' && isExternalHttpUrl(context.srcURL);
  const target = image ? { kind: 'image' as const, url: context.srcURL }
    : isExternalHttpUrl(context.linkURL) ? { kind: 'link' as const, url: context.linkURL } : null;
  return [
    ...(selected ? [
      { id: 'copy', label: 'Copy', click: () => copyTextThenNotify(selected) },
      { type: 'separator' as const },
    ] : []),
    {
      id: 'copy-link', label: image ? 'Copy Image URL' : 'Copy Link', enabled: target !== null,
      click: () => {
        if (target) copyTextThenNotify(target.url, () => events.emit(browserLinkCopiedChannel, target));
      },
    },
    {
      id: 'open-link', label: image ? 'Open Image' : 'Open Link', enabled: target !== null,
      click: () => { if (target) return actions.open(target.url); },
    },
    {
      id: 'open-tab', label: image ? 'Open Image in New Tab' : 'Open Link in New Tab', enabled: target !== null,
      click: () => { if (target) return actions.openTab(target.url); },
    },
    { type: 'separator' },
    { id: 'reload', label: 'Reload', click: actions.reload },
  ];
}
