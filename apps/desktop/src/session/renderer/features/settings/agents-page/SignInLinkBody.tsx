import type { FormEvent } from 'react';
import { Copy } from '@/lib/icons';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { copyExternalLink } from '@renderer/lib/open-external-link';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * 登录窗口的正文(#2507)—— 两种登录(终端里跑 `<cli> login` / 协议登录)长成同一个样子。
 *
 * owner 2026-11-12:「参考个人助理连接应用……有链接就给个链接，搞完之后如果需要验证码，就给个输入框让你填码，
 * 就很简洁。不用像现在这样，打开个类似终端的东西还需要我手填……无非就是给链接，要么等待，要么直接就成了」。
 * ⇒ 照连接应用的 CLI 登录(`integration-setup-modal.tsx` 的 `IntegrationCliLogin`)排:一句等待说明、
 *    设备码(有才出)、复制链接;底部主按钮「打开授权页」。只多一格:CLI 要把码贴回去时的输入框。
 */
export type SignInLinkPhase = 'starting' | 'waiting' | 'verifying' | 'failed';

export type SignInCodeEntry = {
  /** CLI 正在要码(或宿主读不出、人自己点开了)。 */
  open: boolean;
  /** 刚交的码没被接受、CLI 又要了一次。 */
  rejected: boolean;
  /** 宿主说不清在不在要码(老版本的机器):收起时留一个「网页给了授权码?」的入口。 */
  canReveal: boolean;
  /** CLI 要的是授权码还是 API key —— 只换说法,交上去的路是同一条。 */
  kind: 'code' | 'key';
  onReveal(): void;
  onSubmit(code: string): void;
};

export function SignInLinkBody({
  phase,
  link,
  userCode,
  codeEntry,
  failure,
}: {
  phase: SignInLinkPhase;
  link: string | null;
  userCode: string | null;
  codeEntry: SignInCodeEntry | null;
  failure: string | null;
}) {
  const { translate } = useSessionMessages();
  // 要的是 API Key:网页那头不会自己回来,只有粘进来这一条路,不摆「正在等待授权」。
  const wantsKey = codeEntry?.open === true && codeEntry.kind === 'key';

  if (phase === 'failed') {
    return (
      <div className="grid gap-2" data-testid="agent-sign-in-failed">
        <p className="text-sm text-foreground">{translate('agentsPage.signInNotFinished')}</p>
        {failure ? (
          <p className="whitespace-pre-wrap font-mono text-xs leading-5 text-foreground-destructive [overflow-wrap:anywhere]" role="alert">
            {failure}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {phase === 'starting' ? (
        <div className="flex items-center gap-2 text-sm text-foreground-muted" role="status" data-testid="agent-sign-in-starting">
          <LoadingIndicator size="inline" />
          {translate('agentsPage.signInOpening')}
        </div>
      ) : (
        <p className="text-sm leading-6 text-foreground-muted">
          {translate(wantsKey ? 'agentsPage.signInWaitingKey' : 'agentsPage.signInWaiting')}
        </p>
      )}
      {userCode ? (
        <div className="flex items-center justify-between rounded-lg border border-border bg-background-secondary px-3 py-2">
          <span className="text-xs text-foreground-muted">{translate('agentsPage.signInUserCode')}</span>
          <span className="font-mono text-base font-semibold tracking-widest text-foreground" data-testid="agent-sign-in-user-code">
            {userCode}
          </span>
        </div>
      ) : null}
      {codeEntry ? <CodeEntry entry={codeEntry} verifying={phase === 'verifying'} /> : null}
      <div className="flex items-center gap-3">
        {phase === 'verifying' ? (
          <span className="flex items-center gap-2 text-xs text-foreground-muted" role="status">
            <LoadingIndicator size="inline" />
            {translate('agentsPage.signInVerifying')}
          </span>
        ) : phase === 'waiting' && !wantsKey ? (
          <span className="flex items-center gap-2 text-xs text-foreground-muted" role="status" data-testid="agent-sign-in-waiting">
            <LoadingIndicator size="inline" />
            {translate('agentsPage.signInWaitingShort')}
          </span>
        ) : null}
        {link ? (
          <Button
            variant="link"
            size="xs"
            className="ml-auto h-auto p-0 text-xs"
            // 授权页要在别的设备上打开时用;复制成功的提示由 `copyExternalLink` 统一给。
            onClick={() => void copyExternalLink(link)}
            data-testid="agent-sign-in-copy-link"
          >
            <Copy className="mr-1 h-3 w-3" />
            {translate('agentsPage.signInCopyLink')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CodeEntry({ entry, verifying }: { entry: SignInCodeEntry; verifying: boolean }) {
  const { translate } = useSessionMessages();
  if (!entry.open) {
    if (!entry.canReveal) return null;
    return (
      <Button variant="link" size="xs" className="h-auto justify-self-start p-0 text-xs" onClick={entry.onReveal}>
        {translate('agentsPage.signInCodeReveal')}
      </Button>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = ((form.elements.namedItem('code') as HTMLInputElement | null)?.value ?? '').trim();
    if (!value || verifying) return;
    entry.onSubmit(value);
    form.reset();
  };
  return (
    <form className="grid gap-2" onSubmit={submit} data-testid="agent-sign-in-code-form">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          name="code"
          autoComplete="off"
          type={entry.kind === 'key' ? 'password' : 'text'}
          placeholder={translate(entry.kind === 'key' ? 'agentsPage.signInKeyPlaceholder' : 'agentsPage.signInCodePlaceholder')}
          aria-label={translate(entry.kind === 'key' ? 'agentsPage.signInKeyLabel' : 'agentsPage.signInCodeLabel')}
          disabled={verifying}
          className="font-mono"
          data-testid="agent-sign-in-code-input"
        />
        <Button type="submit" variant="outline" disabled={verifying}>
          {translate('agentsPage.signInCodeSubmit')}
        </Button>
      </div>
      {entry.rejected ? (
        <p className="text-xs text-foreground-destructive" role="alert">
          {translate('agentsPage.signInCodeRejected')}
        </p>
      ) : null}
    </form>
  );
}
