import { describe, expect, it } from 'vitest';
import { personalConversationMenu } from './conversation-row-menu';
import { sessionMenu, type SessionMenuAction } from './session-menu';

// 取消并排: an inner-column row's menu offers it only while the row's content is one of the blocks side by side.
describe('取消并排 in the row menus', () => {
  const handled = new Set<SessionMenuAction>(['pin', 'rename', 'archive', 'copy-id', 'leave-split', 'mark-unread', 'notifications', 'reload']);

  it('an agent row: first, only while its task is a block of the split screen', () => {
    expect(sessionMenu('sidebar-row', { pinned: false, sidebarPin: null, inSplit: true }, handled)[0]).toMatchObject({ id: 'leave-split', label: { ns: 'session', key: 'screen.leaveSplit' } });
    expect(sessionMenu('sidebar-row', { pinned: false, sidebarPin: null }, handled).some((item) => item.id === 'leave-split')).toBe(false);
  });

  it('a topic row: first, only while the topic is a block of the split screen', () => {
    expect(personalConversationMenu({ canDelete: true, hasUnread: false, inSplit: true })[0]).toMatchObject({ id: 'leave-split', label: { ns: 'session', key: 'screen.leaveSplit' } });
    expect(personalConversationMenu({ canDelete: true, hasUnread: false }).some((item) => item.id === 'leave-split')).toBe(false);
  });

  it('an agent row: 在新窗口打开 is in its 更多, the task\'s one entry for a window of its own', () => {
    const items = sessionMenu('sidebar-row', { pinned: false, sidebarPin: null, canOpenWindow: true }, new Set([...handled, 'open-window' as const]));
    expect(items.find((item) => item.id === 'open-window')).toMatchObject({ label: { ns: 'session', key: 'screen.openInWindow' }, icon: 'window', fold: true });
  });
});
