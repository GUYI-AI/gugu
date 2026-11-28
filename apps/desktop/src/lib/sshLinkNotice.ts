import { createSelectStore, patch, useSelect, type SelectStore } from './selectStore'
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

// The shell hosts notices and the embedded task owns its recovery panel. Both bundles use the same window.
type Surface = { deviceId: string; reason: SshLinkFailure | null; promptTarget?: HTMLElement }
const key = Symbol.for('gugu.ssh.recoverySurfaces')
const host = globalThis as { [key]?: SelectStore<ReadonlyMap<symbol, Surface>> }
const visible = host[key] ??= createSelectStore<ReadonlyMap<symbol, Surface>>(new Map(), { scope: 'account' })

export function showSshStatusInPlace(deviceId: string, reason: SshLinkFailure | null, promptTarget?: HTMLElement): () => void {
  const surface = Symbol()
  patch(visible, surface, { deviceId, reason, promptTarget })
  return () => patch(visible, surface, undefined)
}

export function useSshStatusShown(deviceId: string, reason: SshLinkFailure | null): boolean {
  return useSelect(visible, surfaces => reason !== null && Array.from(surfaces.values()).some(s => s.deviceId === deviceId && s.reason === reason))
}

export function useSshPromptTarget(deviceId: string): HTMLElement | undefined {
  return useSelect(visible, surfaces => Array.from(surfaces.values()).findLast(s => s.deviceId === deviceId && s.promptTarget)?.promptTarget)
}
