import { ExternalLink } from '@/lib/icons';
import { reaction } from 'mobx';
import { useEffect, useRef, useState } from 'react';
import { AcpAuthLoginBinding } from '@renderer/lib/acp/auth-login-binding';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { openExternalLinkInBrowser } from '@renderer/lib/open-external-link';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
} from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { acpLoginAttemptSucceeded, acpLoginView, type AcpLoginView } from './login-success';
import { SignInLinkBody } from './SignInLinkBody';
import { SignInTitle } from './SignInTitle';

type Props = BaseModalProps<void> & {
  providerId: string;
  methodId: string;
  program?: string;
  providerName: string;
  stepLabel: string | null;
};

/**
 * 协议登录(`acp-authenticate`,#6335)的弹窗正文 —— 与终端登录共用同一个 `agentSignInModal` 入口、
 * 同一个 `startLogin` / `cancelLogin`、同一份登录态,只是没有终端:浏览器由厂商自己拉起。
 *
 * 三件事:
 *  · 等待时一句「已在浏览器打开登录页,完成后回到这里」;
 *  · 厂商打出来的登录链接作为**备用**(「如果浏览器没打开,点这里」)—— ❌ 不自动再开一次,
 *    它已经开过了,再开就是两个标签页;
 *  · 取消 / 关窗 = 取消登录。与终端那条不同:那边关窗不取消,是因为设备码流程要用户离开窗口去授权、
 *    进程得活着;这边进程在后台等 OAuth 回调,关窗之后没有任何界面能再告诉用户它还在等,
 *    留着只是白占一个回调端口到超时。
 */
export function AcpAuthenticateSignIn({
  providerId,
  methodId,
  program,
  providerName,
  stepLabel,
  onSuccess,
  onClose,
}: Props) {
  const { translate } = useSessionMessages();
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<AcpLoginView>({ phase: 'starting', fallbackUrl: null });
  const [startError, setStartError] = useState<string | null>(null);
  const bindingRef = useRef<AcpAuthLoginBinding | null>(null);
  // 父组件每次渲染都可能给一个新的 onSuccess;❌ 不能让它进 effect 依赖 —— 那会把一趟正在等浏览器的
  // 登录取消掉重来。
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  useEffect(() => {
    let disposed = false;
    let stopReaction: (() => void) | null = null;
    setStartError(null);
    setView({ phase: 'starting', fallbackUrl: null });
    void AcpAuthLoginBinding.create({ providerId, methodId, program }).then(
      (binding) => {
        if (disposed) {
          binding.dispose(true);
          return;
        }
        bindingRef.current = binding;
        // 判据同终端那条:挂载那一刻的读数是登录**前**的,❌ 不当本次结果(login-success.ts)。
        const progress = { sawInitialReading: false };
        stopReaction = reaction(
          () => binding.status.current(),
          (state) => {
            if (acpLoginAttemptSucceeded(state, progress)) {
              binding.dispose(false);
              bindingRef.current = null;
              onSuccessRef.current();
              return;
            }
            progress.sawInitialReading = true;
            setView(acpLoginView(state));
          },
          { fireImmediately: true }
        );
      },
      (error: unknown) => {
        if (!disposed) setStartError(error instanceof Error ? error.message : String(error));
      }
    );
    return () => {
      disposed = true;
      stopReaction?.();
      bindingRef.current?.dispose(true);
      bindingRef.current = null;
    };
  }, [attempt, methodId, program, providerId]);

  const failure = startError ?? (view.phase === 'failed' ? view.message : null);
  const link = view.phase === 'waiting' ? view.fallbackUrl : null;

  // 与终端登录同一个样子(#2507):一句等待说明 + 复制链接,底部「打开授权页」。厂商已经自己开过浏览器,
  // 这颗按钮就是从前那句「如果浏览器没打开,点这里」—— ❌ 自动再开一次。
  return (
    <>
      <DialogHeader>
        <SignInTitle
          title={translate('agentsPage.signInToProvider', { provider: providerName })}
          stepLabel={stepLabel}
        />
      </DialogHeader>
      <DialogContentArea className="pt-1" data-testid={failure ? 'acp-sign-in-error' : 'acp-sign-in-waiting'}>
        <SignInLinkBody
          phase={failure ? 'failed' : view.phase === 'starting' ? 'starting' : 'waiting'}
          link={link}
          userCode={null}
          codeEntry={null}
          failure={failure}
        />
      </DialogContentArea>
      <DialogFooter>
        {failure ? (
          <>
            <Button variant="outline" onClick={onClose}>
              {translate('common.close')}
            </Button>
            <Button variant="default" onClick={() => setAttempt((n) => n + 1)}>
              {translate('agentsPage.signInRetry')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => {
                bindingRef.current?.dispose(true);
                bindingRef.current = null;
                onClose();
              }}
            >
              {translate('agentsPage.signInCancel')}
            </Button>
            <Button
              variant="default"
              disabled={!link}
              data-testid="acp-sign-in-fallback"
              onClick={() => link && openExternalLinkInBrowser(link)}
            >
              <ExternalLink className="h-4 w-4" />
              {translate('agentsPage.signInOpenPage')}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
