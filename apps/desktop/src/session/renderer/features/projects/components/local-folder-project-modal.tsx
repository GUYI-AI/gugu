// @@@task-web-host — 网页版的「使用现有文件夹」:桌面版走系统文件夹对话框,网页版没有(那是 Electron 的
// 原生对话框,无头宿主里只会静默取消)。这里给一个咕咕风格的小弹窗:零命名(项目名 = 文件夹名)、
// 一棵长在弹窗里的懒加载目录树(根 = 宿主家目录)、直接创建。
// ❌ 别接到旧的 AddProjectModal(Pick/New/Clone 页签 + 名称输入):那套已删。
import { useState } from 'react';
import { messageForUser } from '@/lib/userFacingError';
import { refreshFailure, useReplica } from '@/lib/replica';
import { ReadingSlot } from '@/components/ui/ReadingSlot';
import { homeDirectory, projectPathInspection } from '@renderer/lib/machine-paths';
import { DirectoryTree } from '@renderer/features/projects/components/add-project-modal/directory-browser/directory-tree';
import { normalizePath } from '@renderer/features/projects/components/add-project-modal/directory-browser/paths';
import { createProjectFromLocalFolder } from '@renderer/features/projects/components/create-project-from-local-folder';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { basenameFromAnyPath } from '@shared/path-name';

export type LocalFolderProjectModalProps = BaseModalProps<string>;

export function LocalFolderProjectModal({ onClose, onSuccess }: LocalFolderProjectModalProps) {
  const { translate } = useSessionMessages();
  // 树从宿主的家目录长起:从 / 开始翻没意义。
  const home = useReplica(homeDirectory, []);
  const [path, setPath] = useState('');
  // 选中的目录不是 git 仓库:放行,给一句提示,❌ 替用户 init。
  const inspection = useReplica(projectPathInspection, path ? [path] : null);
  // Also a read again (the path picked again) failing over the hint read before: said, ❌ the old hint shown as current.
  const inspectionFailure = refreshFailure(inspection);
  const [submitState, setSubmitState] = useState<'idle' | 'creating'>('idle');
  const name = basenameFromAnyPath(path);
  const canSubmit = path.trim().length > 0 && !!name && submitState === 'idle';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitState('creating');
    const projectId = await createProjectFromLocalFolder(path, translate);
    setSubmitState('idle');
    if (!projectId) return;
    onClose();
    onSuccess(projectId);
  };

  return (
    <ModalLayout
      header={
        <DialogHeader showCloseButton={submitState === 'idle'}>
          <DialogTitle>{translate('projects.create.pickFolderTitle')}</DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter className="items-center gap-3">
          <p
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-xs',
              path ? 'text-foreground' : 'text-foreground-muted'
            )}
            title={path || undefined}
          >
            {path || translate('projects.remoteDir.selectDirectory')}
          </p>
          <ConfirmButton type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {translate(submitState === 'creating' ? 'projects.create.creating' : 'projects.remoteDir.useThis')}
          </ConfirmButton>
        </DialogFooter>
      }
    >
      <DialogContentArea data-autofocus tabIndex={-1} className="gap-2">
        <p className="text-sm text-foreground-muted">{translate('projects.create.pickFolderMessage')}</p>
        <div className="h-[320px] overflow-y-auto rounded-md border border-border p-1">
          <ReadingSlot reading={home} placeholder="h-full w-full">
            {(homePath) => <DirectoryTree key={normalizePath(homePath)} rootPath={normalizePath(homePath)} value={path} onChange={setPath} />}
          </ReadingSlot>
        </div>
        {inspection.state === 'value' && inspection.value.isDirectory && !inspection.value.isGitRepo && (
          <p className="text-xs text-foreground-muted">{translate('projects.dirTree.notAGitRepo')}</p>
        )}
        {inspectionFailure && (
          <p className="text-xs text-foreground-destructive">{messageForUser(inspectionFailure)}</p>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
}
