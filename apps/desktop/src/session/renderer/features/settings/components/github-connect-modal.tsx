import { AlertCircle, ArrowRight, ClipboardCopy, KeyRound, type IconComponent } from '@/lib/icons'
import { notify } from '@/lib/notices'
import { useState } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import {
  useGitHubDeviceFlowAuth,
  useSaveGitHubToken,
} from '@renderer/lib/hooks/useGithubAccounts';
import { LibraryHostDialogStatus, LibraryHostFieldset, LibraryHostScope } from '@renderer/features/library/library-host-scope';
import type { LibraryHost } from '@renderer/features/library/library-host';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';

type MethodError = {
  method: 'token' | 'device_flow';
  message: string;
} | null;

/**
 * 连接 GitHub 的两条路:设备码流程、粘贴一个令牌。两条都把令牌存进密码库(github.com 的一份凭据),连接器、项目、
 * App 各自从密码库里选用哪一份。从 gh CLI 导入已去掉:那是密码库之外的第二个凭据来源。
 *
 * 从前这里还有第一张卡「用 OAuth 连接」,走的是一套外部登录服务 —— 那套账号在咕咕里
 * 根本没有入口,这张卡点下去必然失败。2026-09-10 连同整个子系统一起拆掉。
 */
export function GithubConnectModal({
  host,
  ...props
}: BaseModalProps<void> & {
  /** 资源库看的是别的机器时,连的是那台机器上的 GitHub 账号(#6264):gh 读那台机器的,设备码存到那台机器。 */
  host?: LibraryHost;
  onDeviceFlow?: () => void;
}) {
  return (
    <LibraryHostScope host={host}>
      <GithubConnectModalBody {...props} host={host} />
    </LibraryHostScope>
  );
}

function GithubConnectModalBody({ onSuccess, onClose, host, onDeviceFlow }: BaseModalProps<void> & { host?: LibraryHost; onDeviceFlow?: () => void }) {
  const { toast } = useToast();
  const deviceFlowMutation = useGitHubDeviceFlowAuth();
  const saveTokenMutation = useSaveGitHubToken();
  const showDeviceFlow = useShowModal('githubDeviceFlowModal');
  const [token, setToken] = useState('');
  const [pasting, setPasting] = useState(false);
  const [error, setError] = useState<MethodError>(null);
  const { translate } = useSessionMessages();

  const deviceFlowLoading = deviceFlowMutation.isPending;
  const tokenLoading = saveTokenMutation.isPending;
  const anyLoading = tokenLoading || deviceFlowLoading;

  const saveToken = async () => {
    setError(null);
    const result = await saveTokenMutation.mutateAsync({ token });
    if (!result.success) {
      if (host?.connectionMetadataExpected) notify({ tier: 'error', title: result.error });
      setError({ method: 'token', message: result.error });
      return;
    }
    setToken('');
    toast({ title: translate('github.tokenSaved', { login: result.account.login }) });
    onSuccess();
  };

  const connectDeviceFlow = () => {
    setError(null);
    if (onDeviceFlow) onDeviceFlow();
    else showDeviceFlow({ host });
    void deviceFlowMutation.mutateAsync();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{translate('github.connectTitle')}</DialogTitle>
        <LibraryHostDialogStatus />
      </DialogHeader>
      <LibraryHostFieldset>
      <DialogContentArea className="gap-3">
        <ConnectMethodCard
          icon={KeyRound}
          title={translate('github.deviceFlow')}
          description={translate('github.deviceFlowDescription')}
          label={translate('github.deviceFlow')}
          loadingLabel={translate('github.openingDeviceFlow')}
          loading={deviceFlowLoading}
          disabled={anyLoading}
          onClick={connectDeviceFlow}
          error={!host?.connectionMetadataExpected && error?.method === 'device_flow' ? error.message : undefined}
        />

        <ConnectMethodCard
          icon={ClipboardCopy}
          title={translate('github.pasteToken')}
          description={translate('github.pasteTokenDescription')}
          label={translate('github.pasteToken')}
          loadingLabel={translate('github.savingToken')}
          loading={false}
          disabled={anyLoading}
          onClick={() => setPasting(true)}
          error={!host?.connectionMetadataExpected && error?.method === 'token' ? error.message : undefined}
        />
        {pasting ? (
          <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void saveToken(); }}>
            <input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.target.value)}
              placeholder={translate('github.pasteTokenPlaceholder')} aria-label={translate('github.pasteToken')} data-testid="github-paste-token"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm" />
            <Button type="submit" disabled={anyLoading || !token.trim()} data-testid="github-paste-token-save">
              {tokenLoading ? <LoadingIndicator size="inline" /> : translate('github.saveToken')}
            </Button>
          </form>
        ) : null}
      </DialogContentArea>
      </LibraryHostFieldset>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={anyLoading}>
          {translate('common.cancel')}
        </Button>
      </DialogFooter>
    </>
  );
}

function ConnectMethodCard({
  icon: Icon,
  title,
  description,
  label,
  loadingLabel,
  loading,
  disabled,
  onClick,
  error,
}: {
  icon: IconComponent;
  title: string;
  description: string;
  label: string;
  loadingLabel: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
  error?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={loading ? loadingLabel : label}
        className={cn(
          'group flex w-full items-center gap-3 p-3 text-left transition-colors',
          'hover:bg-row-hover active:bg-row-press',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'
        )}
      >
        <Icon className="text-foreground-muted h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <p className="text-foreground-muted mt-0.5 text-xs">{description}</p>
        </div>
        {loading ? (
          <LoadingIndicator size="inline" className="text-foreground-muted" />
        ) : (
          <ArrowRight className="text-foreground-muted h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
        )}
      </button>
      {error && <InlineError message={error} className="mx-3 mt-2 mb-3" />}
    </div>
  );
}

function InlineError({ message, className }: { message: string; className?: string }) {
  return (
    <div
      className={cn(
        'bg-background-destructive text-foreground-destructive flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs',
        className
      )}
    >
      <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
