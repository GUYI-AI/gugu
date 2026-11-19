import { when } from 'mobx';
import { fileBaseName } from '@renderer/features/sessions/stores/workspace-path';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { rpc } from '@renderer/lib/ipc';
import { extensionSurfaceStore } from './extension-surface-store';
import { extensionViewStore } from './extension-view-store';

/**
 * A tab with unsaved edits asks before it goes, the same question for any file: save, drop, or stay. Only its page can do
 * either, and it answers by saying again whether anything is unsaved. Not saved (the disk or the machine out of reach): it stays.
 */
export async function confirmCloseOfUnsaved(sessionId: string | null, tabId: string, filePath?: string): Promise<boolean> {
  const { dirtyIn, dirtyReports } = extensionSurfaceStore.state(sessionId, tabId);
  if (dirtyIn === null) return true;
  const choice = await new Promise<'save' | 'discard' | null>((resolve) =>
    showModal('unsavedChangesModal', {
      fileName: fileBaseName(filePath ?? ''),
      onSuccess: (result) => resolve(result === 'save' ? 'save' : 'discard'),
      onClose: () => resolve(null),
    })
  );
  if (!choice) return false;
  const told = await rpc.extensions.invokeCommand({ webContentsId: dirtyIn, commandId: `gugu.file.${choice}:${tabId}` });
  // The page is gone: its edits wait in their draft, and come back when the file opens again.
  if (!told.success) return true;
  await when(() => extensionSurfaceStore.state(sessionId, tabId).dirtyReports > dirtyReports);
  return extensionSurfaceStore.state(sessionId, tabId).dirtyIn === null;
}

/**
 * Build the page drawn in this slot again from the start (it did not load, it threw, it is stuck): the tab's menu and the
 * error details wherever an App's page shows its error. Unsaved edits are asked about first, as for closing the tab.
 */
export async function reloadAppPage(sessionId: string | null, tabId: string, filePath?: string): Promise<void> {
  if (!(await confirmCloseOfUnsaved(sessionId, tabId, filePath))) return;
  const page = extensionViewStore.pageOfSlot(sessionId, tabId);
  if (page) extensionViewStore.reload(page);
}
