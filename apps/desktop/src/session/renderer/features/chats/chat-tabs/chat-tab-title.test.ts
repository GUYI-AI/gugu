// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { folderItem, unresolvedItem, type PanelItem } from './chat-panel-item';

// The Files App opens .md files in its `file` page, titled `Files`; a board App's own page is titled `Board`.
vi.mock('@renderer/features/extensions/installed-extensions-store', async (original) => ({
  ...(await original<object>()),
  installedExtensionsStore: { tabTitle: (kind: string) => (kind.startsWith('workspace.') ? 'Files' : kind.startsWith('board.') ? 'Board' : undefined), isChatFile: () => false },
}));
const { panelPresentation } = await import('./chat-tab-providers');

const silent = { title: null, badge: null, error: null };
const saying = (title: string) => ({ ...silent, title });

describe('a file\'s tab has one name from the click to its content', () => {
  it('waiting, opened before its page has said anything, and drawn: the file\'s name each time, no `Files` beside it', () => {
    const waiting = unresolvedItem('A', 'fo-notes.md', 'open-1');
    const opened: PanelItem = { kind: 'workspace.file', itemId: 'A', title: 'fo-notes.md', fileName: 'fo-notes.md' };
    const shown = [panelPresentation(silent, waiting, 'Folder'), panelPresentation(silent, opened, 'Folder'), panelPresentation(saying('fo-notes.md'), opened, 'Folder')];
    expect(shown.map(({ label, hint }) => ({ label, hint }))).toEqual(Array(3).fill({ label: 'fo-notes.md', hint: undefined }));
  });

  it('a page that names itself otherwise (an HTML title) still says so beside the file\'s name', () => {
    const opened: PanelItem = { kind: 'workspace.file', itemId: 'A', title: 'fo-notes.md', fileName: 'fo-notes.md' };
    expect(panelPresentation(saying('Meeting notes'), opened, 'Folder')).toMatchObject({ label: 'fo-notes.md', hint: 'Meeting notes' });
  });

  it('an App\'s own page (no file) keeps the App\'s title until it says its own; the folder its own name', () => {
    expect(panelPresentation(silent, { kind: 'board.main', title: '' }, 'Folder').label).toBe('Board');
    expect(panelPresentation(saying('Sprint 12'), { kind: 'board.main', title: '' }, 'Folder').label).toBe('Sprint 12');
    expect(panelPresentation(silent, folderItem(), 'Chat folder').label).toBe('Chat folder');
  });
});
