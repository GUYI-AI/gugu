import { translateSessionMessage } from '@renderer/localization/locale-store';
import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useRef, useState } from 'react';
import { createGroupWithFolder } from '@renderer/features/folders/create-group-with-folder';
import { getDraggedFilePaths, hasDraggedFiles } from '@renderer/lib/drag-files';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { log } from '@renderer/utils/logger';
import { basenameFromAnyPath } from '@shared/path-name';

export function useSidebarDrop() {
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);
  const { navigate } = useNavigate();
  const { toast } = useToast();

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter.current++;
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);

      const filePaths = getDraggedFilePaths(e.dataTransfer);
      if (filePaths.length === 0) return;

      void Promise.allSettled(
        filePaths.map(async (filePath) => {
          try {
            const status = await rpc.folders.inspectFolderPath(filePath);
            if (status.error) {
              toast({
                title: translateSessionMessage('sidebar.addProjectFailed'),
                description: messageForUser(status.error),
                variant: 'destructive',
              });
              return null;
            }
            if (!status.isDirectory) {
              toast({
                title: translateSessionMessage('sidebar.addProjectFailed'),
                description: translateSessionMessage('sidebar.dropFolderRequired'),
                variant: 'destructive',
              });
              return null;
            }
            if (!status.isGitRepo) {
              toast({
                title: translateSessionMessage('sidebar.addProjectFailed'),
                description: translateSessionMessage('sidebar.dropGitRequired', { name: basenameFromAnyPath(filePath) }),
                variant: 'destructive',
              });
              return null;
            }

            const name = basenameFromAnyPath(filePath);
            // A folder dropped on the sidebar = 用现有文件夹新建群 (the group is named after it).
            return await createGroupWithFolder({ name, machine: null, path: filePath });
          } catch (err) {
            log.error('Failed to make a group with a dropped folder:', err);
            toast({
              title: translateSessionMessage('sidebar.addProjectFailed'),
              description: messageForUser(err),
              variant: 'destructive',
            });
            return null;
          }
        })
      ).then((results) => {
        const chatIds = results.flatMap((r) =>
          r.status === 'fulfilled' && r.value != null ? [r.value] : []
        );
        const firstChatId = chatIds[0];

        if (firstChatId) {
          navigate('chat', { chatId: firstChatId });
        }

        if (chatIds.length > 1) {
          toast({
            title: 'Groups added',
            description: `${chatIds.length} groups added.`,
          });
        }
      });
    },
    [navigate, toast]
  );

  return { isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop };
}
