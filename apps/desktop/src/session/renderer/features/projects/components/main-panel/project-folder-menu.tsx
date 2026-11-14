import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import type { ReactElement } from 'react';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { ContextMenu, MenuItem } from '@/components/ui/Menu';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ProjectFoldersState, ShownFolder } from './project-folders';

export function ProjectFolderMenu({ folder, projectName, state, disabled, children }: {
  folder: ShownFolder;
  projectName: string;
  state: Pick<ProjectFoldersState, 'detach' | 'folders'>;
  disabled: boolean;
  children: ReactElement;
}) {
  const { translate } = useSessionMessages();
  // 项目至少有一个文件夹(各台机器合计):最后一个摘不掉 —— 要不要这个项目,走「删除项目」。读不到列表时按「只剩一个」算。
  const isLast = (state.folders?.length ?? 0) <= 1;
  const detach = async () => {
    try {
      await state.detach(folder);
      toast({
        title: translate('projects.folders.detached', { path: folder.path, projectName }),
        duration: 8000,
        action: {
          label: translate('projects.folders.undo'),
          // The last folder can unmount this card. Undo must work independently of its hook state.
          onClick: () => { void restore(folder); },
        },
      });
    } catch (error) { rendererLogger('actions/project-folder-menu').error({ error: error }, 'action failed'); toast({ tier: 'error', title: translate('projects.folders.errorDetach'), description: messageForUser(error) }); }
  };
  const restore = async (detached: ProjectFolder) => {
    try {
      const result = await rpc.projects.attachProjectFolder(detached.projectId, detached.path);
      if (!result.success) throw new Error(result.error.message);
    } catch (error) { rendererLogger('actions/project-folder-menu').error({ error: error }, 'action failed');
      toast({ tier: 'error', title: translate('projects.folders.errorAttach'), description: messageForUser(error) });
    }
  };
  return (
    <ContextMenu.Root onOpenChange={(open, details) => {
      if (open && (disabled || folder.offline)) details.cancel();
    }}>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Content onClick={(event) => event.stopPropagation()}>
        <MenuItem
          disabled={disabled || folder.offline || isLast}
          title={isLast ? translate('projects.folders.detachLast') : undefined}
          onClick={() => { void detach(); }}
        >
          {translate('projects.folders.detach')}
        </MenuItem>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
