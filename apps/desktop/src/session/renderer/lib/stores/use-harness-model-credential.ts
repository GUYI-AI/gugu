import type { HarnessModelCredentialStatus } from '@gugu/session-core/agents/plugins';
import { harnessModelCredential } from './agent-replicas';
import { useHostReplica } from './host-replica';

/**
 * 「这家 harness 自报的某个自家模型,其 provider 在本机有没有凭据」—— composer 默认预选规则
 * (product spec「模型来源与 UI」,#4956)的渲染层读数(the `harnessModelCredential` replica).
 *
 * `null` = 还没读到:模型触发器画占位(❌ 先按自家默认画、读到 'uncredentialed' 再跳到平台)。
 * 读失败或没有要问的模型 = `'unknown'`:维持自家默认。
 *
 * 登录动作之后整家重读:`harnessModelCredential.refresh(undefined, providerId)`(登录改变的是这家的整个凭据面)。
 */
export function useHarnessModelCredential(
  providerId: string | null | undefined,
  modelId: string | null | undefined
): HarnessModelCredentialStatus | null {
  // #6264 会话 / 新建框在别的机器上:凭据在那台机器上,问那台机器的 agent-config 运行时。
  const asked = !!providerId && !!modelId;
  const reading = useHostReplica(harnessModelCredential, asked ? [providerId, modelId] : null);
  // A failed read is the domain's own `'unknown'` (❌ `'uncredentialed'`); the replica's read logs the error.
  if (!asked || reading.state === 'error') return 'unknown';
  return reading.state === 'value' ? reading.value : null;
}
