import type { HarnessModelCredentialStatus } from '@gugu/session-core/agents/plugins';
import { useReplica, type Reading } from '@/lib/replica';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { harnessModelCredential } from './agent-replicas';

/**
 * 「这家 harness 自报的某个自家模型,其 provider 在本机有没有凭据」—— composer 默认预选规则
 * (product spec「模型来源与 UI」,#4956)的渲染层读数(the `harnessModelCredential` replica).
 *
 * `null` = 还没读到:默认预选此刻判不了,模型触发器画占位(❌ 先按自家默认画、读到 'uncredentialed' 再跳到平台)。
 * 读失败 = `'unknown'`(判不出,见 `credentialStatus`):这条读数的诚实退化就是维持自家默认,失败本身在读数里,
 * 由 `harnessModelCredential` 的读记日志。
 * 没有要问的模型(这家目录没就绪)= `'unknown'`,不发请求。
 *
 * 登录动作之后整家重读:`harnessModelCredential.refresh(providerId)`(登录改变的是这家的整个凭据面)。
 */
export function useHarnessModelCredential(
  providerId: string | null | undefined,
  modelId: string | null | undefined
): HarnessModelCredentialStatus | null {
  // #6264 会话 / 新建框在别的机器上:凭据在那台机器上,问那台机器的 agent-config 运行时。
  const host = useLibraryHost().remote;
  const machine = host?.deviceId ?? null;
  const asked = !!providerId && !!modelId;
  const reading = useReplica(harnessModelCredential, asked ? [providerId, modelId, machine] : null, { read: host?.online !== false });
  if (!asked) return 'unknown';
  return credentialStatus(reading);
}

/** A failed read is the domain's own `'unknown'` (❌ `'uncredentialed'`); the replica's read logs the error. */
function credentialStatus(reading: Reading<HarnessModelCredentialStatus>): HarnessModelCredentialStatus | null {
  switch (reading.state) {
    case 'unknown': return null;
    case 'error': return 'unknown';
    case 'value': return reading.value;
  }
}
