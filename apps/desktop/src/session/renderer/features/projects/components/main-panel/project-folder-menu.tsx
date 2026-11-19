import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import type { ReactElement } from 'react';
import type { GroupFolder } from '@renderer/features/folders/group-folders-store';
import { groupFoldersStore } from '@renderer/features/folders/group-folders-store';
import type { GroupFoldersState } from '@renderer/features/folders/group-folders';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpcOn } from '@renderer/lib/ipc';
import { ContextMenu, MenuItem } from '@/components/ui/Menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** A folder paper's right-click menu: unbind it from the group (its files, sessions and history stay; a group may hold none). */
export function ProjectFolderMenu({ folder, chatId, groupName, state, disabled, children }: {
  folder: GroupFolder;
  chatId: string;
  groupName: string;
  state: Pick<GroupFoldersState, 'detach'>;
  disabled: boolean;
  children: ReactElement;
}) {
  const { translate } = useSessionMessages();
  const log = rendererLogger('actions/group-folder-menu');
  const detach = async () => {
    try {
      await state.detach(folder);
      toast({
        title: translate('projects.folders.detached', { path: folder.path, projectName: groupName }),
        duration: 8000,
        action: {
          label: translate('projects.folders.undo'),
          // Undo is binding it again; it must work after this card's state is gone.
          onClick: () => { void restore(); },
        },
      });
    } catch (error) {
      log.error({ error }, 'action failed');
      toast({ tier: 'error', title: translate('projects.folders.errorDetach'), description: messageForUser(error) });
    }
  };
  const restore = async () => {
    try {
      const result = await rpcOn(folder.deviceId).folders.bindFolderAtPath({ path: folder.path, chatId });
      if (!result.success) throw new Error(result.error.type, { cause: result.error });
      void groupFoldersStore.readMachine(folder.deviceId);
    } catch (error) {
      log.error({ error }, 'action failed');
      toast({ tier: 'error', title: translate('projects.folders.errorAttach'), description: messageForUser(error) });
    }
  };
  return (
    <ContextMenu.Root onOpenChange={(open, details) => {
      if (open && (disabled || folder.offline)) details.cancel();
    }}>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
        <MenuItem disabled={disabled || folder.offline} onClick={() => { void detach(); }}>
          {translate('projects.folders.detach')}
        </MenuItem>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
