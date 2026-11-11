import { ExternalLink } from '@/lib/icons'
// 「复制去那台机器上敲」的一行命令:与设置 → 设备里那几处同一个 CommandBlock,❌ 另写一份孪生体。
import { CommandBlock } from '@/components/settings/addServer/CommandBlock';
import '@/i18n/registerSettingsCatalog';
import { reaction } from 'mobx';
import { useEffect, useRef, useState } from 'react';
import { AcpAuthLoginBinding } from '@renderer/lib/acp/auth-login-binding';
import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { openExternalLinkInBrowser } from '@renderer/lib/open-external-link';
import { cancelsLoginOnClose, loginAttemptSucceeded, pendingUrlToOpen, rereadOnReturn } from './login-success';
import { SignInLinkBody, type SignInCodeEntry, type SignInLinkPhase } from './SignInLinkBody';
import { AcpAuthenticateSignIn } from './AcpAuthenticateSignIn';
import { resolveSignInMethods } from './agent-account';
import { useAgent } from '@renderer/lib/stores/use-agents';
import { SignInTitle } from './SignInTitle';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { rendererLogger } from '@/lib/log';

/**
 * #6264 登录发生在**别的机器上**(会话 / 新建框在那台机器上)。窗口还是这一个、绑定也是同一个
 * (那台机器的 agent-config 运行时,一套工作台),只是:
 *  · 跑这家「不靠回跳」的登录方式(设备码 / 把码贴回终端)—— 浏览器在这台电脑上,回跳到不了那台机器;
 *  · 这家没有这种登录方式时,不起终端,如实说「到那台机器的终端里敲哪条命令」。
 */
export type AgentSignInRemoteTarget = {
  deviceId: string;
  deviceLabel: string;
  /** 这家声明了不靠回跳的登录方式(`headlessArgs`)。 */
  headless: boolean;
  /** 只能自己登时,在那台机器终端里要敲的命令。 */
  command: string;
};

/** 一步登录:哪个方法、哪个程序、怎么登。 */
export type AgentSignInStep = {
  methodId: string;
  /**
   * 登哪个程序(#6335)。缺席 = 主程序;给了 = 那个伴随程序(Antigravity 终端腿的 `agy`)——
   * 两个程序不共享登录,各有各的登录进程与读数。
   */
  program?: string;
  /**
   * 这个方法怎么登:`terminal`(缺席即此)= 起终端跑 `<cli> login`;`acp-authenticate` = 咕咕替它发
   * 协议登录,厂商自己开浏览器 —— 同一个弹窗入口,❌ 不另起一个平行的登录弹窗(#6335)。
   */
  transport?: 'terminal' | 'acp-authenticate';
};

export type AgentSignInModalArgs = {
  connectionId?: string;
  providerId: string;
  providerName: string;
  /**
   * 这一下要依次跑的几步(#6335)。一个程序的家永远是一步,与从前一模一样;一家几个程序、各自登录时,
   * 资源库那一行只有一颗按钮,点下去把还没登的那几个**按顺序**登完(全都登了就全部重登)。
   * 一步成功(或用户点「完成」)就接着下一步;任何一步取消 / 关窗即整趟结束,已经登上的照样算数。
   */
  steps: AgentSignInStep[];
  /** #6264 在别的机器上登(只走终端登录那一种,一步)。 */
  remote?: AgentSignInRemoteTarget;
};

/** 登录绑定的那张面 —— 本机与远端各一种,窗口不分。 */
type LoginBinding = Pick<AcpAuthLoginBinding, 'sendInput' | 'resize' | 'markUrlHandled' | 'dispose'> & {
  status: { current(): AuthStatusModelState };
  /** 再问一次登录态(本机那种有;远端那台由它自己判成没成)。 */
  refreshStatus?: () => void;
};

type AgentSignInModalProps = BaseModalProps<void> & AgentSignInModalArgs;

type StepProps = BaseModalProps<void> & {
  connectionId?: string;
  providerId: string;
  providerName: string;
  methodId: string;
  program?: string;
  /** 多步时标题旁的「第 1 步,共 2 步」;单步为 null,❌ 不多画。 */
  stepLabel: string | null;
  remote?: AgentSignInRemoteTarget;
};

export function AgentSignInModal({ providerId, providerName, steps, remote, connectionId, onSuccess, onClose }: AgentSignInModalProps) {
  const { translate } = useSessionMessages();
  const [index, setIndex] = useState(0);
  // 这一步的程序声明了不止一种登录方法(CodeBuddy 国际版 / 中国版)时,先让用户挑;挑过的按步记着。
  const agent = useAgent(providerId).data;
  const [chosen, setChosen] = useState<Record<number, string>>({});
  // 远端但这家登不了 / 宿主给不了:不起终端,说清楚下一步。
  if (remote && !remote.headless) {
    const values = { provider: providerName, device: remote.deviceLabel };
    return (
      <>
        <DialogHeader>
          <DialogTitle>{translate('remoteLogin.title', values)}</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-3">
          <p className="text-sm text-foreground">{translate('remoteLogin.unsupported', values)}</p>
          <CommandBlock command={remote.command} />
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translate('common.close')}
          </Button>
        </DialogFooter>
      </>
    );
  }
  const listed = steps[index];
  if (!listed) return null;
  // 远端只走终端登录那一种(见 `remote`),不摆选择。
  const choices = remote ? [] : resolveSignInMethods(agent?.capabilities, listed.program);
  if (choices.length > 1 && chosen[index] === undefined) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{translate('agentsPage.signInChooseMethod', { provider: providerName })}</DialogTitle>
        </DialogHeader>
        <DialogContentArea className="flex flex-col gap-2">
          {choices.map((method) => (
            <Button
              key={method.id}
              variant="outline"
              className="justify-start"
              data-testid={`agent-sign-in-method-${method.id}`}
              onClick={() => setChosen((current) => ({ ...current, [index]: method.id }))}
            >
              {method.name}
            </Button>
          ))}
        </DialogContentArea>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {translate('common.cancel')}
          </Button>
        </DialogFooter>
      </>
    );
  }
  const picked = choices.find((method) => method.id === chosen[index]);
  const step: AgentSignInStep = picked
    ? {
        ...listed,
        methodId: picked.id,
        transport: picked.kind === 'acp-authenticate' ? 'acp-authenticate' : 'terminal',
      }
    : listed;
  const last = index >= steps.length - 1;
  const props: StepProps = {
    connectionId,
    providerId,
    providerName,
    methodId: step.methodId,
    ...(step.program === undefined ? {} : { program: step.program }),
    stepLabel:
      steps.length > 1 ? translate('agentsPage.signInStep', { current: String(index + 1), total: String(steps.length) }) : null,
    ...(remote ? { remote } : {}),
    onSuccess: last ? onSuccess : () => setIndex((current) => current + 1),
    onClose,
  };
  // key 按步:换一步就是换一趟登录,上一步的绑定随卸载收尾。协议登录只在本机(远端只走终端登录)。
  return step.transport === 'acp-authenticate' && !remote ? (
    <AcpAuthenticateSignIn key={index} {...props} />
  ) : (
    <LinkSignIn key={index} {...props} />
  );
}

/**
 * 登录进程没有可见的终端了,把它的宽度放到足够大:Ink 一类的 CLI 会按终端宽度给长链接**硬折行**,
 * 折开的链接主进程拼不回来(主进程也把登录终端起得一样宽,这一下是给老版本的机器补的)。
 */
const LOGIN_COLS = 1000;
const LOGIN_ROWS = 40;
/** 登录命令正常退出、但读数还没翻成「已登录」:等这么久再说没登上(退出后主进程要重探一次登录态)。 */
const EXIT_GRACE_MS = 10_000;

/**
 * 终端登录(`cli-login`)的窗口 —— 跑的仍是厂商自己的 `<cli> login`,只是**不再把终端摆给人**(#2507):
 * 链接 + 等待;CLI 要把码贴回去时给一个输入框;设备码单独摆出来;失败时把 CLI 最后几行原话摆出来。
 * 读数全来自主进程那份登录态(`pendingUrl` / `userCode` / `awaitingInput` / `exit.tail`)。
 */
function LinkSignIn({
  connectionId,
  providerId,
  methodId,
  program,
  providerName,
  stepLabel,
  remote,
  onSuccess,
  onClose,
}: StepProps) {
  const { translate } = useSessionMessages();
  const [attempt, setAttempt] = useState(0);
  const [startFailed, setStartFailed] = useState(false);
  const [state, setState] = useState<AuthStatusModelState | null>(null);
  /** 这次登录印出来的链接;主进程那格被标成已处理后就清空了,这里留着。 */
  const [link, setLink] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  /** 交码那一刻 CLI 已经要过几次码;之后它再要一次(计数变大)= 刚交的码没被接受。 */
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  /** 人从浏览器回到过这个窗口:这时还没登上,才给「网页给了授权码?」的手动入口。 */
  const [returned, setReturned] = useState(false);
  const [exitGraceOver, setExitGraceOver] = useState(false);
  const bindingRef = useRef<LoginBinding | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const remoteDeviceId = remote?.deviceId ?? null;

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    let startedSignedOut: boolean | null = null;
    const handled = new Set<string>();
    setStartFailed(false);
    setState(null);
    setLink(null);
    setRevealed(false);
    setSubmittedAt(null);
    setReturned(false);
    setExitGraceOver(false);
    /**
     * 人从浏览器回到这个窗口(`focus`)那一下再问一次登录态:有的家登完不退出(Antigravity 的 `agy`,#6335),
     * 退出是它从前唯一会触发重读的事件。只挂事件,❌ 轮询。从「已登录」开始的那一趟(换账号)不挂 ——
     * 那时重读只会读到旧凭据,把窗口在他还没换完时关掉(`loginAttemptSucceeded` 抬头那条同一个坑)。
     */
    const onFocus = () => {
      if (!startedSignedOut) return;
      setReturned(true);
      bindingRef.current?.refreshStatus?.();
    };
    window.addEventListener('focus', onFocus);
    void AcpAuthLoginBinding.create({
      connectionId,
      providerId,
      methodId,
      program,
      // #6264 别的机器:在那台机器上跑这家不靠回跳的那种登录。
      ...(remoteDeviceId ? { machine: remoteDeviceId, headless: true } : {}),
    }).then(
      (binding) => {
        if (disposed) {
          binding.dispose();
          return;
        }
        bindingRef.current = binding;
        binding.resize(LOGIN_COLS, LOGIN_ROWS);
        // 挂载这一刻的登录态是**登录前**的读数,❌ 当成本次的结果(判据与为什么见 `login-success.ts`)。
        const progress = { sawInitialReading: false };
        stop = reaction(
          () => binding.status.current(),
          (current) => {
            startedSignedOut ??= rereadOnReturn(current);
            if (loginAttemptSucceeded(current, progress)) {
              // 凭据已落地 ⇒ 这一趟的进程可以收掉(登完不退出的家不收就一直挂着)。
              binding.dispose(true);
              bindingRef.current = null;
              onSuccessRef.current();
              return;
            }
            progress.sawInitialReading = true;
            const pending = pendingUrlToOpen(current, handled);
            if (pending) {
              handled.add(pending.id);
              setLink(pending.url);
              binding.markUrlHandled(pending.id);
            }
            setState(current);
          },
          { fireImmediately: true }
        );
      },
      (error: unknown) => {
        // 起不来是宿主那头的故障,原文进日志;界面只说「没有登录成功」并给「重试」。
        rendererLogger('settings/agent-sign-in').warn({ error, providerId }, 'login start failed');
        if (!disposed) setStartFailed(true);
      }
    );
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener('focus', onFocus);
      // 关窗取消不取消,判据在 `cancelsLoginOnClose`:本机 ❌ 取消(设备码流程要人离开窗口去授权,
      // 厂商的 `<cli> login` 得活着才收得到);别的机器取消(窗口没了就再没人盯着那台机器上的登录命令)。
      bindingRef.current?.dispose(cancelsLoginOnClose({ remote: !!remoteDeviceId }));
      bindingRef.current = null;
    };
  }, [attempt, connectionId, methodId, program, providerId, remoteDeviceId]);

  const login = state?.login ?? null;
  const exit = login?.exit ?? null;
  const exitedCleanly = exit?.exitCode === 0 && !exit.signal;
  useEffect(() => {
    if (!exitedCleanly) return;
    const timer = window.setTimeout(() => setExitGraceOver(true), EXIT_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [exitedCleanly]);

  const prompts = login?.inputPromptCount ?? 0;
  const askingAgain = submittedAt !== null && login?.awaitingInput === true && prompts > submittedAt;
  const failed = startFailed || (exit !== null && (!exitedCleanly || exitGraceOver));
  // 登录命令自己打出来的最后几行是给人看的原话(厂商写给用户的),不是我们的内部异常。
  const failure = !startFailed && failed ? exit?.tail || null : null;
  const phase: SignInLinkPhase = failed
    ? 'failed'
    : exit !== null || (submittedAt !== null && !askingAgain)
      ? 'verifying'
      : !login || (!link && !login.userCode)
        ? 'starting'
        : 'waiting';
  // 宿主读得出「在不在要码」(新版本)⇒ 只在它要的时候开;读不出(老版本的机器)⇒ 留手动入口。
  const hostReadsPrompt = login?.awaitingInput !== undefined;
  const codeEntry: SignInCodeEntry | null = login && !failed
    ? {
        open: login.awaitingInput === true || revealed,
        rejected: askingAgain,
        canReveal: !hostReadsPrompt || returned,
        kind: login.inputKind ?? 'code',
        onReveal: () => setRevealed(true),
        onSubmit: (code) => {
          bindingRef.current?.sendInput(`${code}\r`);
          setSubmittedAt(prompts);
          setRevealed(false);
        },
      }
    : null;

  const remoteValues = remote ? { provider: providerName, device: remote.deviceLabel } : null;

  return (
    <>
      <DialogHeader>
        <SignInTitle
          title={remoteValues
            ? translate('remoteLogin.title', remoteValues)
            : translate('agentsPage.signInToProvider', { provider: providerName })}
          stepLabel={stepLabel}
        />
      </DialogHeader>
      <DialogContentArea className="pt-1" data-testid="agent-sign-in-link-body">
        <SignInLinkBody
          phase={phase}
          link={link}
          userCode={login?.userCode ?? null}
          codeEntry={codeEntry}
          failure={failure}
        />
      </DialogContentArea>
      <DialogFooter>
        {failed ? (
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
              onClick={() => link && openExternalLinkInBrowser(link)}
              data-testid="agent-sign-in-open-page"
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
