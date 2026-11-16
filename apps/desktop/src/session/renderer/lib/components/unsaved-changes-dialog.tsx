import { Trans } from 'react-i18next';
import { i18n } from '@/i18n';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

export type UnsavedChangesDialogResult = 'save' | 'discard';

export type UnsavedChangesDialogArgs = {
  fileName: string;
};

type Props = BaseModalProps<UnsavedChangesDialogResult> & UnsavedChangesDialogArgs;

export function UnsavedChangesDialog({ fileName, onSuccess }: Props) {
  const { translate } = useSessionMessages();
  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>{translate('file.unsavedChangesTitle')}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="pt-0">
        <p>
          <Trans
            i18n={i18n}
            ns="session"
            i18nKey="file.unsavedChangesDescription"
            values={{ fileName }}
            tOptions={{ interpolation: { prefix: '{', suffix: '}' } }}
            components={{ file: <strong /> }}
          />
        </p>
      </DialogContentArea>
      <DialogFooter className="gg-confirm-action-footer">
        <Button variant="outline" onClick={() => onSuccess('discard')}>
          {translate('file.discardChanges')}
        </Button>
        <Button data-autofocus onClick={() => onSuccess('save')}>{translate('common.save')}</Button>
      </DialogFooter>
    </>
  );
}
