import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useLibraryHost, type LibraryRemoteDevice } from '@renderer/features/library/library-host';
import { subscriptionKey } from '@renderer/features/settings/subscriptions/subscription-queries';
import { useAgentAuthStatuses } from '@renderer/lib/stores/use-agent-auth-status';
import { forceRefreshHarnessModelCatalog } from '@renderer/lib/stores/use-harness-model-catalog';
import { harnessModelCredentialKey } from '@renderer/lib/stores/use-harness-model-credential';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { agentConnectionForm, type AgentPayload } from '@shared/core/agents/agent-payload';
import { accountRowOf, mergeAccountRows, resolveAccountTargets, type MergedAccountRow } from './agent-account';

/**
 * 「登录这个智能体」的那一个动作 —— 资源库详情的账号行与设置「订阅」页的「未登录」共用(#2507)。
 *
 * owner 2026-11-12:订阅页说「去资源库 → 智能体里登录」,却点不了,新用户根本找不到。
 * ⇒ 两处点的是同一个函数、打开同一个登录窗口,❌ 订阅页再指路到另一页。
 * 没有可登录方法的家 `row` 为 null:调用方据此不给入口,❌ 摆一句指向不存在入口的提示(subscriptions.md)。
 */
export function useAgentSignIn(
  agent: AgentPayload,
  options: {
    probe?: boolean;
    /**
     * 登哪台机器(缺席 = 资源库正在看的那台)。连接面板也从新建任务、会话里打开,那里没有资源库的机器,
     * 由调用方按会话所在的机器给(null = 本机)。
     */
    remote?: Pick<LibraryRemoteDevice, 'deviceId' | 'deviceLabel'> | null;
  } = {}
): { row: MergedAccountRow | null; openSignIn: () => void; refreshAuth: () => Promise<void> } {
  const targets = resolveAccountTargets(agent);
  // #6264 资源库看的是别的机器:读数与登录都在**那台机器上**(同一组动词,rpc 送到那台机器),行还是这一行。
  const host = useLibraryHost();
  const remote = options.remote === undefined ? host.remote : options.remote;
  // 没有可登录的方法就一个都不问(空列表会被读成「问主程序」)。
  const local = useAgentAuthStatuses(
    targets.length > 0 ? agent.id : null,
    targets.map((target) => target.program),
    { machine: remote?.deviceId ?? null, ...(options.probe === false ? { probe: false } : {}) }
  );
  const refreshAuth = local.refresh;
  const queryClient = useQueryClient();
  const showSignIn = useShowModal('agentSignInModal');
  const row = mergeAccountRows(targets.map((target, index) => accountRowOf(target, local.auths[index])));
  const machine = remote?.deviceId ?? null;
  /**
   * 有 API Key 连接、账号是它 CLI 自己那一份的家(#2507):这一趟登的、读的是「现有 CLI 配置」(`native`)。
   * 选着一把 key 时主读数是那把 key(恒「已登录」),拿它判会在登录还没走完时就关窗;登录进程的环境由主进程定成原生。
   */
  const form = agentConnectionForm(agent);
  const loginConnectionId = form && !form.accounts ? 'native' : undefined;

  /**
   * 装上 / 卸掉 / 换一份之后重探一次登录态。挂载时那一探若赶在装好之前,读到的是「没这个程序」
   * 那种判不出(`unknown`),而弹窗一直开着就一直停在那 —— 要关掉重开才会翻(#6335 首测实录)。
   * 只在安装读数**变了**时探:首次挂载那一探由 `useAgentAuthStatuses` 自己发,❌ 不重复。
   * 看的是每个程序各自那一份安装读数(只补装了终端那个程序时同样要翻)。
   */
  const installKey = targets.map((target) => target.installStatus ?? '').join('|');
  const lastInstall = useRef(installKey);
  useEffect(() => {
    if (lastInstall.current === installKey) return;
    lastInstall.current = installKey;
    void refreshAuth();
  }, [installKey, refreshAuth]);

  const openSignIn = useCallback(() => {
    if (remote) {
      /** 在那台机器上登:登完 / 关窗都让那台机器上这一家的读数(账号、模型目录)重问一遍。 */
      const refresh = () => {
        void refreshAuth();
        void queryClient.invalidateQueries({ queryKey: ['agents'] });
        void queryClient.invalidateQueries({ queryKey: subscriptionKey(machine, agent.id) });
      };
      const main = row?.steps.find((step) => step.program === undefined) ?? row?.steps[0];
      const method = main?.method;
      const cliArgs = method?.kind === 'cli-login' ? method.args : [];
      showSignIn({
        providerId: agent.id,
        providerName: agent.name,
        ...(loginConnectionId ? { connectionId: loginConnectionId } : {}),
        steps: method ? [{ methodId: method.id }] : [],
        remote: {
          deviceId: remote.deviceId,
          deviceLabel: remote.deviceLabel,
          headless: method?.kind === 'cli-login' && !!method.headlessArgs,
          // 只能自己登时,在那台机器终端里要敲的命令:CLI 名取这家的可执行文件名(与那台机器同一个名字)。
          command: [agent.command?.split(/[\\/]/).filter(Boolean).pop() || agent.id, ...cliArgs].join(' '),
        },
        onSuccess: refresh,
        onClose: refresh,
      });
      return;
    }
    /**
     * 登录完**强制**重读三样:这一家的登录态、它的模型目录、它的模型凭据读数。
     *
     * 目录那份带 force —— 主进程的 TTL 对「用户刚刚登完」这件事一无所知,不跳过它的话
     * composer 会继续显示那句「需要先登录」,用户以为没登上又去登一遍(#5605 一族)。
     * 三者用的都是**已有**那几把 react-query key,所以 composer 手上那份当场跟着翻。
     * 成功与关窗都走同一条:登录成没成只有 harness 知道,关窗那一下同样要重问(见 `login-success.ts`)。
     *
     * 只有主程序在这一趟里登过时才强制重探目录:模型目录与凭据是主程序起出来的
     * (`harness-model-catalog` 探的是主程序),伴随程序的登录一个字节都不影响它们。
     */
    const touchesMain = (row?.steps ?? []).some((step) => step.program === undefined);
    const refreshAfterLogin = () => {
      void refreshAuth();
      void queryClient.invalidateQueries({ queryKey: subscriptionKey(machine, agent.id) });
      if (!touchesMain) return;
      void forceRefreshHarnessModelCatalog(queryClient, agent.id);
      void queryClient.invalidateQueries({ queryKey: harnessModelCredentialKey(agent.id) });
    };
    showSignIn({
      providerId: agent.id,
      providerName: agent.name,
      ...(loginConnectionId ? { connectionId: loginConnectionId } : {}),
      steps: (row?.steps ?? []).map((step) => ({
        methodId: step.method.id,
        ...(step.program === undefined ? {} : { program: step.program }),
        transport: step.method.kind === 'acp-authenticate' ? 'acp-authenticate' : 'terminal',
      })),
      onSuccess: refreshAfterLogin,
      onClose: refreshAfterLogin,
    });
  }, [agent.id, agent.name, agent.command, queryClient, refreshAuth, row?.steps, showSignIn, remote, machine, loginConnectionId]);

  return { row, openSignIn, refreshAuth };
}


