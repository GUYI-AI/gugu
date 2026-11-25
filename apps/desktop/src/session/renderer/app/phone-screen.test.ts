// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishChatSummaries } from '@/lib/chatSummariesBridge';
import { clearChatRemovalFacts, publishChatRemovalFacts, publishChatRemoved } from '@/lib/chatRemovalBridge';
import { installPhoneScreen, showChatOnPhone } from './screen-layout-actions';
import { screenLayout } from './screen-layout';
import { createShellTabStore } from '@/lib/shellTab';

vi.mock('@/lib/replica', async (original) => ({ ...(await original<typeof import('@/lib/replica')>()), replicaAccount: () => ({ id: 'me', live: true }) }));

const chats = [
  { id: 'g1', kind: 'group', unread_count: 0 },
  { id: 't1', kind: 'topic', unread_count: 0, source_chat_id: 'g1' },
  { id: 't2', kind: 'topic', unread_count: 0, source_chat_id: 'g1' },
  { id: 'dm', kind: 'dm', unread_count: 0 },
];

/** 手机壳的两条路:列表点一行(ChatListPanel),会话页画着的那条换了(MainLayout 跟着它)。返回会话页画的那条。 */
let drawn: string | null = null;
const tapRow = (chatId: string) => open(showChatOnPhone(chatId, true));
const open = (chatId: string) => {
  drawn = chatId;
  showChatOnPhone(chatId);
  return drawn;
};

describe('手机会话页 = 只摆一块的那一屏:话题算在它的群下(同桌面 #3729)', () => {
  let uninstall: () => void = () => {};
  beforeEach(() => {
    screenLayout.replaceWith(null);
    drawn = null;
    publishChatSummaries(chats);
    uninstall = installPhoneScreen();
  });
  afterEach(() => {
    uninstall();
    clearChatRemovalFacts();
    publishChatSummaries([]);
    screenLayout.replaceWith(null);
  });

  it('进话题 → 返回列表 → 点同一个群:停在那个话题上;中间去过别的对话也一样', () => {
    expect(tapRow('g1')).toBe('g1');
    open('t1'); // 群里的话题条点进话题
    expect(tapRow('g1'), 'back to the list, the same group').toBe('t1');
    expect(tapRow('dm')).toBe('dm');
    expect(tapRow('g1'), 'another chat in between').toBe('t1');
  });

  it('群里换到另一个话题,记录跟着更新;话题条选「群聊」= 回群本身,记录也清掉', () => {
    tapRow('g1');
    open('t1');
    open('t2');
    expect(tapRow('g1'), 'the topic last left on').toBe('t2');
    open('g1');
    expect(screenLayout.parkedContents).toEqual([]);
    expect(tapRow('dm')).toBe('dm');
    expect(tapRow('g1'), 'went back to the group itself').toBe('g1');
  });

  it('从别处(通知、链接)开的话题也算在它的群下', () => {
    tapRow('dm');
    open('t2');
    tapRow('dm');
    expect(tapRow('g1')).toBe('t2');
  });

  it('群的链接、通知打开群本身:会话页画的是群,这屏也回到群本身', () => {
    tapRow('g1');
    open('t1');
    tapRow('dm');
    expect(open('g1')).toBe('g1');
    expect(tapRow('g1')).toBe('g1');
  });

  it('话题归档(删除)后再进群:回主群,❌ 停在不在了的话题上 —— 它收起着、正摆着都一样', () => {
    tapRow('g1');
    open('t1');
    tapRow('dm');
    publishChatRemovalFacts('me', (chatId) => chatId === 't1');
    expect(tapRow('g1'), 'parked under its group').toBe('g1');

    open('t2');
    publishChatRemoved('me', 't2');
    expect(tapRow('g1'), 'the one on the page').toBe('g1');
  });
});

/**
 * 带上手机的返回栈(lib/shellTab.ts @@@phone-chat-trail),照 MainLayout 的接法:列表点一行 = setChatFrom('chats');
 * 会话页开着时进另一条 = enterChat 把屏上那条压进栈;返回 = leavePhoneChat 弹栈,弹空了回列表。
 */
describe('手机返回栈:进话题 → 返回到列表 → 再进群,停在话题上', () => {
  let uninstall: () => void = () => {};
  let active: string | null = null;
  const listeners = new Set<() => void>();
  const shell = createShellTabStore('chats', {
    activeId: () => active,
    listed: (chatId) => chats.some((chat) => chat.id === chatId),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  const draw = (chatId: string) => { active = chatId; showChatOnPhone(chatId); for (const listener of listeners) listener(); };
  const tapListRow = (chatId: string) => { draw(showChatOnPhone(chatId, true)); shell.setChatFrom('chats'); };
  /** enterChat + setActiveChatId (openChatTarget: the topic bar, links, notifications). */
  const enter = (chatId: string) => { shell.openChat(shell.root(), active !== chatId ? active : null); draw(chatId); };
  /** leavePhoneChat: true = still on the chat page. */
  const back = () => {
    const under = shell.popChat();
    if (under && 'chatId' in under) { draw(under.chatId); return true; }
    shell.setChatFrom(null);
    return false;
  };
  const backToList = () => { while (back()); expect(shell.chatShown()).toBe(false); };

  beforeEach(() => {
    screenLayout.replaceWith(null);
    active = null;
    shell.setChatFrom(null);
    publishChatSummaries(chats);
    uninstall = installPhoneScreen();
  });
  afterEach(() => {
    uninstall();
    publishChatSummaries([]);
    screenLayout.replaceWith(null);
  });

  it('群 → 话题条进话题 → 返回(弹栈)到列表 → 再点这个群:停在话题上', () => {
    tapListRow('g1');
    expect(active).toBe('g1');
    enter('t1');
    expect(active).toBe('t1');
    backToList();
    tapListRow('g1');
    expect(active, 'back to the topic it was left on').toBe('t1');
  });
});
