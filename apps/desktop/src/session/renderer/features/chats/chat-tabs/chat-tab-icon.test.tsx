// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { FILE_MARKS } from '@gugu/session-shared/file-marks';
import type { PanelItem } from './chat-panel-item';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The strip's two slots for a panel tab: the mark before its name, and what follows the name.
vi.mock('@renderer/features/tabs/tab-bar/generic-tab-item', () => ({
  GenericTabDragPreview: () => null,
  GenericTabItem: ({ preSlot, statusSlot }: { preSlot?: ReactNode; statusSlot?: ReactNode }) => (
    <><span data-slot="pre">{preSlot}</span><span data-slot="status">{statusSlot}</span></>
  ),
}));
// Office is an installed App with a page of its own (so in `openableApps`); its chat files open in `office.main`.
vi.mock('@renderer/features/extensions/installed-extensions-store', async (original) => ({
  ...(await original<object>()),
  installedExtensionsStore: {
    tabTitle: () => 'Office', isChatFile: () => false, manifestFor: () => undefined,
    openableApps: [{ extensionId: 'office', name: 'Office', kind: 'office.main', iconDataUrl: null }],
  },
}));
vi.mock('@/components/RailAppIcon', () => ({ RailAppIcon: () => <i data-app-icon="" /> }));
vi.mock('@/components/chat/chatFolderName', () => ({ useChatFolderName: () => 'Chat folder' }));
// The deck is kept on a machine; the notes are in the cloud.
vi.mock('@/lib/fileHost', () => ({ useFileHost: (itemId: string | null) => (itemId === 'deck' ? { device: 'd', account: 'a' } : null), openFileStorageSettings: () => {} }));
vi.mock('@/components/appSlot/FileHostMark', () => ({ FileHostMark: () => <b data-host-mark="" /> }));

const { chatPanelTabProvider } = await import('./chat-tab-providers');

function strip(item: PanelItem) {
  const el = document.createElement('div');
  const root = createRoot(el);
  const Item = chatPanelTabProvider.TabBarItem!;
  act(() => root.render(<Item tab={{ tabId: 't', resource: { state: item } } as never} host={{} as never} ctx={{ place: { kind: 'chat', chatId: 'chat' } } as never} />));
  const pre = el.querySelector('[data-slot=pre]')!, status = el.querySelector('[data-slot=status]')!;
  const read = { app: !!pre.querySelector('[data-app-icon]'), glyph: pre.querySelector('svg')?.innerHTML, devicon: pre.querySelector('i[class*=devicon]')?.className, hostBefore: !!pre.querySelector('[data-host-mark]'), hostAfter: !!status.querySelector('[data-host-mark]') };
  act(() => root.unmount());
  return read;
}

describe('a chat tab is marked by what it shows, as it is named', () => {
  it('a file an App opened: the file\'s family mark from the one table, not the App\'s icon', () => {
    const deck = strip({ kind: 'office.main', itemId: 'deck', title: 'report.pptx', fileName: 'report.pptx' });
    expect(deck.app).toBe(false);
    expect(deck.glyph).toBe(FILE_MARKS.slides.glyph);
  });

  it('a markdown file: the text family mark, as in the folder and on its card', () => {
    const notes = strip({ kind: 'workspace.file', itemId: 'notes', title: 'notes.md', fileName: 'notes.md' });
    expect(notes.devicon).toBeUndefined();
    expect(notes.glyph).toBe(FILE_MARKS.text.glyph);
  });

  it('a code file keeps its devicon', () => {
    expect(strip({ kind: 'workspace.file', itemId: 'code', title: 'main.ts', fileName: 'main.ts' }).devicon).toMatch(/devicon-typescript/);
  });

  it('the App\'s own page keeps the App\'s icon', () => {
    expect(strip({ kind: 'office.main', title: '' }).app).toBe(true);
  });

  it('the machine a file is kept on follows the name, not beside the type mark', () => {
    expect(strip({ kind: 'office.main', itemId: 'deck', title: 'report.pptx', fileName: 'report.pptx' })).toMatchObject({ hostBefore: false, hostAfter: true });
    expect(strip({ kind: 'workspace.file', itemId: 'notes', title: 'notes.md', fileName: 'notes.md' })).toMatchObject({ hostBefore: false, hostAfter: false });
  });
});
