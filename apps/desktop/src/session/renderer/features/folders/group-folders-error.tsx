import { observer } from 'mobx-react-lite';
import { groupFoldersStore } from './group-folders-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

/** The account's group folders could not be read: one line + retry (the group picker). Read / still reading = nothing drawn. */
export const GroupFoldersError = observer(function GroupFoldersError({ className }: { className?: string }) {
  const { translate } = useSessionMessages();
  if (groupFoldersStore.status !== 'error') return null;
  return (
    <p className={cn('m-0 text-sm text-foreground-muted', className)} data-testid="group-folders-error" title={groupFoldersStore.error ?? undefined}>
      {translate('projects.error.accountList')}{' '}
      <button
        type="button"
        className="cursor-pointer text-foreground-info underline-offset-2 hover:underline"
        onClick={(event) => {
          event.stopPropagation();
          void groupFoldersStore.refresh();
        }}
      >
        {translate('projects.error.retry')}
      </button>
    </p>
  );
});
