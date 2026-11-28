import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export type PermanentDeleteDialogArgs = {
  count: number;
  /**
   * 标题与正文可以由调用方给(按项目 / 按时间删时说法不同,owner 2026-11-27 00:57);不给就是第 2 稿那一句
   * 「永久删除 N 条会话？删除后无法恢复。」(owner 01:03「直接写删除多少条就行」)。
   */
  title?: string;
  description?: string;
};

/**
 * 两条以上的永久删除问这一次(一条不问,给 8 秒撤销)。只有「取消」「永久删除」两个按钮,**两个都不是默认按钮**:
 * 回车什么也不做(❌ ConfirmButton —— 它绑着 app.confirm,回车就删),Esc / 点外面 = 取消。
 * 初始焦点落在标题上,不落在任何一个按钮上(NN/g「best not to have a default answer at all」;Apple HIG 同)。
 */
export function PermanentDeleteDialog({ count, title, description, onSuccess, onClose }: PermanentDeleteDialogArgs & BaseModalProps<true>) {
  const { translate } = useSessionMessages();
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle data-autofocus tabIndex={-1} className="outline-none" data-testid="permanent-delete-title">
          {title ?? translate('sessionHistory.deleteTitle', { count })}
        </DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <p className="text-foreground-muted">{description ?? translate('sessionHistory.deleteBody')}</p>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} data-testid="permanent-delete-cancel">
          {translate('common.cancel')}
        </Button>
        <Button variant="destructive" onClick={() => onSuccess(true)} data-testid="permanent-delete-confirm">
          {translate('sessionHistory.deleteConfirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
