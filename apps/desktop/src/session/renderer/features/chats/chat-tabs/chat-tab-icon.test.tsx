// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { FILE_MARKS } from '@gugu/session-shared/file-marks';
import type { PanelItem } from './chat-panel-item';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The strip's two slots for a panel tab: the mark before its name, and the mark that stays after it.
vi.mock('@renderer/features/tabs/tab-bar/generic-tab-item', () => ({
  GenericTabDragPreview: () => null,
  GenericTabItem: ({ preSlot, markSlot }: { preSlot?: ReactNode; markSlot?: ReactNode }) => (
    <><span data-slot="pre">{preSlot}</span><span data-slot="mark">{markSlot}</span></>
  ),
}));
// Office is an installed App with a page of its own (so in `openableApps`); its chat files open in `office.main`.
const apps = vi.hoisted(() => ({
  tabTitle: () => 'Office', isChatFile: () => false, manifestFor: () => undefined, sideWidth: () => undefined,
  openableApps: [{ extensionId: 'office', name: 'Office', kind: 'office.main', iconDataUrl: null }],
  // Office declared an icon for .pptx (`fileIcons`); nothing else here declares one.
  fileIcon: (kind: string, name: string) => (kind === 'office.main' && name.endsWith('.pptx') ? 'data:image/png;base64,cHB0eA==' : null),
}));
vi.mock('@renderer/features/extensions/installed-extensions', async (original) => ({
  ...(await original<object>()),
  useInstalledApps: () => ({ state: 'value', value: apps, stale: false, error: null }),
  peekInstalledAppsTracked: () => apps,
}));
vi.mock('@/components/RailAppIcon', () => ({ RailAppIcon: () => <i data-app-icon="" /> }));
vi.mock('@/components/chat/chatFolderName', () => ({ useChatFolderName: () => 'Chat folder' }));
// The deck is kept on a machine; the notes are in the cloud.
vi.mock('@/lib/fileHost', () => ({ useFileHost: (itemId: string | null) => (itemId === 'deck' ? { device: 'd', account: 'a' } : null), openFileStorageSettings: () => {} }));
vi.mock('@/components/appSlot/FileHostMark', () => ({ FileHostMark: () => <b data-host-mark="" /> }));

const { chatPanelTabProvider } = await import('./chat-tab-providers');

/** A family's glyph as the DOM serializes it (what `FileMark` puts in its svg). */
function glyph(family: keyof typeof FILE_MARKS) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.innerHTML = FILE_MARKS[family].glyph;
  return svg.innerHTML;
}

function strip(item: PanelItem) {
  const el = document.createElement('div');
  const root = createRoot(el);
  const Item = chatPanelTabProvider.TabBarItem!;
  act(() => root.render(<Item tab={{ tabId: 't', resource: { state: item } } as never} host={{} as never} ctx={{ place: { kind: 'chat', chatId: 'chat' } } as never} />));
  const pre = el.querySelector('[data-slot=pre]')!, mark = el.querySelector('[data-slot=mark]')!;
  const read = { app: !!pre.querySelector('[data-app-icon]'), img: pre.querySelector('img')?.getAttribute('src') ?? null, glyph: pre.querySelector('svg')?.innerHTML, devicon: pre.querySelector('i[class*=devicon]')?.className, hostBefore: !!pre.querySelector('[data-host-mark]'), hostAfter: !!mark.querySelector('[data-host-mark]') };
  act(() => root.unmount());
  return read;
}

describe('a chat tab shows a file the way the folder list does', () => {
  it('a file whose App declared an icon for it: that icon, not the App\'s own', () => {
    const deck = strip({ kind: 'office.main', itemId: 'deck', title: 'report.pptx', fileName: 'report.pptx' });
    expect(deck).toMatchObject({ app: false, img: 'data:image/png;base64,cHB0eA==' });
  });

  it('a file its App declared no icon for: the host\'s file mark of its family', () => {
    const sheet = strip({ kind: 'office.main', itemId: 'sheet', title: 'budget.xlsx', fileName: 'budget.xlsx' });
    expect(sheet).toMatchObject({ app: false, img: null, glyph: glyph('sheet') });
    const notes = strip({ kind: 'workspace.file', itemId: 'notes', title: 'notes.md', fileName: 'notes.md' });
    expect(notes).toMatchObject({ img: null, devicon: undefined, glyph: glyph('text') });
    const code = strip({ kind: 'workspace.file', itemId: 'code', title: 'main.ts', fileName: 'main.ts' });
    expect(code).toMatchObject({ img: null, devicon: undefined, glyph: glyph('code') });
  });

  it('the App\'s own page keeps the App\'s icon', () => {
    expect(strip({ kind: 'office.main', title: '' }).app).toBe(true);
  });

  it('the machine a file is kept on follows the name, not beside the type mark', () => {
    expect(strip({ kind: 'office.main', itemId: 'deck', title: 'report.pptx', fileName: 'report.pptx' })).toMatchObject({ hostBefore: false, hostAfter: true });
    expect(strip({ kind: 'workspace.file', itemId: 'notes', title: 'notes.md', fileName: 'notes.md' })).toMatchObject({ hostBefore: false, hostAfter: false });
  });
});
