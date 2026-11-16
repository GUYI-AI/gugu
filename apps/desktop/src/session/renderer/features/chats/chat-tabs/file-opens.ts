import { action } from 'mobx';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { AppOpenWithDetail } from '@shared/extensions/app-runtime-protocol';
import type { TabOpenIntent } from '@shared/view-state';
import { rendererLogger } from '@/lib/log';
import { UI_EVENTS } from '@/lib/uiEvents';
import { askChat, askChatFile, chatPageOrigin, chatPaneOf, closeChatTab, dropAsk, panelTabsOf } from './chat-layouts';
import { isUnresolvedItem, type PanelItem } from './chat-panel-item';

const log = rendererLogger('chat-tabs/file-opens');

/**
 * A file opened before its host answered (a card, a link, an App page's list): each open has its asker's id and at most
 * one waiting page, the one it put up (`wait`, that page's `waitId`). Its answer turns that page into the file
 * (`settleFileOpen`); no page coming of it takes the page back (`failFileOpen`). Another file asked meanwhile takes the
 * page over, and the earlier answer then opens nothing. An open with no page of its own has its answer go as any answer.
 */
const opens = new Map<string, { chatId: string; itemId: string; wait: string | null }>();

type FileOpenStart = { itemId: string; fileName?: string; from?: string; intent?: TabOpenIntent; message?: MessageItem };

/** An open begins: its waiting page asked of the chat (taken when the chat is up: `useChatOpener`). */
export function beginFileOpen(openId: string, chatId: string, { itemId, fileName, from, intent, message }: FileOpenStart): void {
  opens.set(openId, { chatId, itemId, wait: null });
  askChat(chatId, { itemId, unresolved: { openId, ...(fileName ? { fileName } : {}) }, ...(message ? { message } : {}), ...(from ? { from } : {}), ...(intent ? { intent } : {}) });
  window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }));
}

/** An App page's open (`slot`: the page's; the phone's frame knows its tab): its waiting page as that page's next page, the page's own state kept on it first. */
export function beginTabFileOpen(chatId: string, tabId: string, openId: string, { viewState, ...start }: Omit<FileOpenStart, 'from'> & { viewState?: Record<string, unknown> }): void {
  if (viewState) chatPaneOf(chatId, tabId)?.setPageViewState(tabId, viewState);
  beginFileOpen(openId, chatId, { ...start, from: tabId });
}
export function beginPageFileOpen(slot: string, openId: string, file: Parameters<typeof beginTabFileOpen>[3]): void {
  const origin = chatPageOrigin(slot);
  if (origin) beginTabFileOpen(origin.chatId, origin.tabId, openId, file);
}

/** The chat put up this open's waiting page (`waitId` = its id), or could not — then it has none, said loudly. */
export function waitShown(openId: string, error?: unknown): void {
  const open = opens.get(openId);
  if (open && error === undefined) open.wait = openId;
  else if (open) {
    log.error({ error: String(error), itemId: open.itemId }, 'the waiting page could not be shown; the answer opens as any');
    opens.delete(openId);
  }
}

/**
 * The open's answer: `{ wait }` turns that page into the file in place; `{}` opens it as any answer (no page of its own,
 * or another chat's file — its wait here taken back); null: the person moved on (another file in its place, the page
 * closed, Back from it) — nothing opens, unless the file is open anyway (asked twice: the other open turned it real).
 */
export const settleFileOpen = action(function settleFileOpen(openId: string | undefined, answer: Pick<AppOpenWithDetail, 'chatId' | 'itemId'>): { wait?: string } | null {
  const open = openId ? opens.get(openId) : undefined;
  if (!openId || !open) return {};
  opens.delete(openId);
  const at = open.wait && answer.chatId === open.chatId ? waitingPage(open.chatId, open.wait) : null;
  if (at?.current) return { wait: open.wait! };
  takeBack(open.chatId, openId, open.wait);
  if (!open.wait || answer.chatId !== open.chatId) return {};
  return panelTabsOf(open.chatId).some((tab) => tab.item.itemId === open.itemId && !isUnresolvedItem(tab.item)) ? {} : null;
});

/** No page of this chat came of the open (refused, not a page, failed to hand over): its waiting page goes, wherever it is. */
export const failFileOpen = action(function failFileOpen(openId: string): void {
  const open = opens.get(openId);
  opens.delete(openId);
  if (open) takeBack(open.chatId, openId, open.wait);
});

/** A waiting page its answer did not turn into a page (a pick, the image viewer) goes. */
export const takeBackWait = (chatId: string, wait: string): void => takeBack(chatId, wait, wait);

/** The open's ask still in the mailbox, and its waiting page in any tab's history (on screen: back to the page before). */
function takeBack(chatId: string, openId: string, wait: string | null): void {
  dropAsk(chatId, (ask) => 'unresolved' in ask && ask.unresolved.openId === openId);
  const at = wait ? waitingPage(chatId, wait) : null;
  if (at && chatPaneOf(chatId, at.tabId)?.discardPage(at.tabId, (state) => (state as PanelItem | undefined)?.waitId === wait) === 'alone') closeChatTab(chatId, at.tabId);
}

/** The tab whose history holds this waiting page, and whether it is the page on screen there. */
function waitingPage(chatId: string, wait: string): { tabId: string; current: boolean } | null {
  for (const tab of panelTabsOf(chatId)) {
    if (tab.item.waitId === wait) return { tabId: tab.tabId, current: true };
    if (chatPaneOf(chatId, tab.tabId)?.navigationOf(tab.tabId)?.pages.some((page) => (page.state as PanelItem | undefined)?.waitId === wait)) return { tabId: tab.tabId, current: false };
  }
  return null;
}

/** A link's file, asked of its chat as the shell hands it (MainLayout): with the host's answer, or before it (null: its open begins). */
export function askFileOpen(
  chatId: string,
  target: { itemId: string; at?: Record<string, string> },
  source: { message?: MessageItem; restore?: () => void; fileName?: string; from?: string; intent?: TabOpenIntent; openId?: string },
  opener: AppOpenWithDetail | null,
): Promise<void> {
  if (!opener) {
    if (source.openId) beginFileOpen(source.openId, chatId, { ...source, itemId: target.itemId });
    return Promise.resolve();
  }
  // The answer carries its own intent (`opener.intent`); what closing hands back goes with it only.
  const { message, from, restore } = source;
  return askChatFile(chatId, { itemId: target.itemId, opener, ...(target.at ? { at: target.at } : {}), ...(message ? { message } : {}), ...(from ? { from } : {}), ...(restore ? { restore } : {}) });
}
