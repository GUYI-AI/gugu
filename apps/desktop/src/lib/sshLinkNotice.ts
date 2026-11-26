import type { SshLinkFailure } from './sshLink'

/** 要这张卡片出面的原因。纯连不上、要先登录 = 用到那台机器的地方各自就地说(登录在那里点),这里不重复、不打扰。 */
const NOTICE_REASONS: ReadonlySet<SshLinkFailure> = new Set([
  'hostKeyChanged',
  'updateFailed',
  'refused',
  'updating',
  'waitingIdle',
  'confirmationRequired',
  'notSignedIn',
  'notInstalled',
  'notRunning',
])

export type SshLinkNotice = { deviceId: string; name: string; reason: SshLinkFailure }

/** Each machine owns its notice. The shared notice deck handles order and deferral. */
export function sshLinkNoticeReason(problem: SshLinkFailure | null): SshLinkFailure | null {
  return problem && NOTICE_REASONS.has(problem) ? problem : null
}
