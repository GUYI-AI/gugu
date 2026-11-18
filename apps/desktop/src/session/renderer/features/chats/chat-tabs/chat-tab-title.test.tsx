// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { PanelItem } from './chat-panel-item';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// What the strip is handed for a panel tab: its label and the grey hint beside it.
const shown = vi.hoisted(() => [] as { label: string; hint?: string }[]);
vi.mock('@renderer/features/tabs/tab-bar/generic-tab-item', () => ({
  GenericTabDragPreview: () => null,
  GenericTabItem: ({ label, hint }: { label: string; hint?: string }) => { shown.push({ label, hint }); return null; },
}));
// The Files App opens .md in its `file` page, titled `Files`; a board App's own page is titled `Board`.
vi.mock('@renderer/features/extensions/installed-extensions-store', async (original) => ({
  ...(await original<object>()),
  installedExtensionsStore: { tabTitle: (kind: string) => (kind.startsWith('workspace.') ? 'Files' : kind.startsWith('board.') ? 'Board' : undefined), isChatFile: () => false, openableApps: [], manifestFor: () => undefined },
}));
vi.mock('@/components/chat/chatFolderName', () => ({ useChatFolderName: () => 'Chat folder' }));
vi.mock('@/lib/fileHost', () => ({ useFileHost: () => null, openFileStorageSettings: () => {} }));

const { chatPanelTabProvider } = await import('./chat-tab-providers');
const { extensionSurfaceStore } = await import('@renderer/features/extensions/extension-surface-store');
const { groupPageSlot, folderItem } = await import('./chat-panel-item');

function stripLabel(item: PanelItem, said?: string) {
  const tabId = `tab-${shown.length}`;
  if (said) act(() => extensionSurfaceStore.say(null, groupPageSlot('chat', tabId), { title: said }));
  const Item = chatPanelTabProvider.TabBarItem!;
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Item tab={{ tabId, resource: { state: item } } as never} host={{} as never} ctx={{ place: { kind: 'chat', chatId: 'chat' } } as never} />));
  act(() => root.unmount());
  return shown.at(-1);
}

const notes: PanelItem = { kind: 'workspace.file', itemId: 'A', title: 'fo-notes.md', fileName: 'fo-notes.md' };

describe('a file\'s tab has one name from the click to its content', () => {
  it('before its page says anything and once it does: the file\'s name, no `Files` beside it', () => {
    expect(stripLabel(notes)).toEqual({ label: 'fo-notes.md', hint: undefined });
    expect(stripLabel(notes, 'fo-notes.md')).toEqual({ label: 'fo-notes.md', hint: undefined });
  });

  it('a page that names itself otherwise still says so beside the file\'s name', () => {
    expect(stripLabel(notes, 'Meeting notes')).toEqual({ label: 'fo-notes.md', hint: 'Meeting notes' });
  });

  it('an App\'s own page keeps the App\'s title until it says its own; the folder its own name', () => {
    expect(stripLabel({ kind: 'board.main', title: '' })?.label).toBe('Board');
    expect(stripLabel({ kind: 'board.main', title: '' }, 'Sprint 12')?.label).toBe('Sprint 12');
    expect(stripLabel(folderItem())?.label).toBe('Chat folder');
  });
});
