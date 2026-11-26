import { createSelectStore, patch, useSelect } from './selectStore'
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

// A task and Settings can both display the same device. Each visible surface owns its own registration.
const visible = createSelectStore<ReadonlyMap<symbol, string>>(new Map(), { scope: 'account' })

export function showSshStatusInPlace(deviceId: string, reason: SshLinkFailure): () => void {
  const surface = Symbol()
  patch(visible, surface, deviceId + ':' + reason)
  return () => patch(visible, surface, undefined)
}

export function useSshStatusShown(deviceId: string, reason: SshLinkFailure | null): boolean {
  return useSelect(visible, surfaces => reason !== null && Array.from(surfaces.values()).includes(deviceId + ':' + reason))
}
