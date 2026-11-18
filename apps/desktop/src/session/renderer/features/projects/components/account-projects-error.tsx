import { observer } from 'mobx-react-lite';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

/** 账号上的项目读不到:一行说读不到 + 重试(侧栏项目分区、项目选择器同一行)。读到了 / 还在读 = 不画。 */
export const AccountProjectsError = observer(function AccountProjectsError({ className }: { className?: string }) {
  const { translate } = useSessionMessages();
  if (accountProjectsStore.status !== 'error') return null;
  return (
    <p className={cn('m-0 text-sm text-foreground-muted', className)} data-testid="account-projects-error" title={accountProjectsStore.error ?? undefined}>
      {translate('projects.error.accountList')}{' '}
      <button
        type="button"
        className="cursor-pointer text-foreground-info underline-offset-2 hover:underline"
        onClick={(event) => {
          event.stopPropagation();
          void accountProjectsStore.refresh();
        }}
      >
        {translate('projects.error.retry')}
      </button>
    </p>
  );
});
