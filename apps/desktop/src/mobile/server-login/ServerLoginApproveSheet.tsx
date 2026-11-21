import { metadataSeparator } from '@/i18n/format'
import { messageForUser } from '@/lib/userFacingError';
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { Button } from '../../components/ui/Button'
import { Sheet } from '../../components/ui/Sheet'
import { RefreshFailed } from '../../components/ui/RefreshFailed'
import { MachineLimitNotice } from '../../components/settings/addServer/MachineLimitNotice'
import { PLATFORM_NAMES } from '../../lib/deviceRowModel'
import { rendererLogger } from '../../lib/log'
import { replica, useReplica } from '../../lib/replica'
import { decideServerLogin, readServerLoginRequest, type ServerLoginRequest, type ServerLoginState } from './serverLoginApproval'

const log = rendererLogger('mobile/server-login')

type View =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'request'; request: ServerLoginRequest; busy: boolean; error: string | null }
  | { kind: 'final'; state: Exclude<ServerLoginState, 'pending'>; hostname: string | null; refusal: MachineLimitRefusal | null }

/** The request the link names (read on each open: it is decided once, elsewhere too). Not kept across restarts. */
const serverLoginRequest = replica({
  name: 'serverLoginRequest',
  scope: 'account',
  read: (_owner: string, code: string): Promise<ServerLoginRequest> => readServerLoginRequest(code),
})

type Decision = { code: string; busy: boolean; error: string | null; final: { state: Exclude<ServerLoginState, 'pending'>; refusal: MachineLimitRefusal | null } | null }

/**
 * 批准一台跑了 `gugu-server login` 的机器(手机上点了那条链接)。机器信息摆在「允许」正上方,写明只有自己刚在那台机器上
 * 执行了登录才点 —— 与网页确认页同一条防钓鱼规矩。点完等云端答了才换结局,❌ 先报「已允许」。
 */
export function ServerLoginApproveSheet({ code, onDone }: { code: string | null; onDone: () => void }) {
  const { t } = useTranslation('settings')
  const reading = useReplica(serverLoginRequest, code === null ? null : [code])
  const [decision, setDecision] = useState<Decision | null>(null)
  const decided = decision?.code === code ? decision : null

  const decide = (request: ServerLoginRequest, approve: boolean) => {
    setDecision({ code: request.code, busy: true, error: null, final: null })
    decideServerLogin(request.code, approve).then(
      (answer) => {
        if (answer.state === 'pending') throw new Error('still pending')
        setDecision({ code: request.code, busy: false, error: null, final: { state: answer.state, refusal: answer.refusal } })
      },
    ).catch((error: unknown) => {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'server-login decide failed')
      setDecision({ code: request.code, busy: false, error: messageForUser(error), final: null })
    })
  }

  const view: View = reading.state === 'unknown' ? { kind: 'loading' }
    : reading.state === 'error'
      ? { kind: 'failed', message: reading.error.message === 'not_found' ? t('devices.approveServer.notFound') : t('devices.approveServer.loadFailed') }
      : decided?.final ? { kind: 'final', state: decided.final.state, hostname: reading.value.machine.hostname, refusal: decided.final.refusal }
        : reading.value.state === 'pending' ? { kind: 'request', request: reading.value, busy: !!decided?.busy, error: decided?.error ?? null }
          : { kind: 'final', state: reading.value.state, hostname: reading.value.machine.hostname, refusal: null }

  const busy = view.kind === 'request' && view.busy
  return (
    <Sheet open={code !== null} onClose={() => { if (!busy) onDone() }} mobileFitContent desktopWidth="380px" testId="server-login-approve" ariaLabel={t('devices.approveServer.title')}>
      <div className="flex flex-col gap-3 px-5 pb-5 pt-6" data-approve-state={view.kind === 'final' ? view.state : view.kind}>
        {view.kind === 'loading' && <p className="text-[length:var(--font-body)] text-[var(--text-secondary)]">{t('devices.approveServer.loading')}</p>}
        {view.kind === 'failed' && (
          <>
            <p className="text-[length:var(--font-body)] text-[var(--text-primary)]" role="alert">{view.message}</p>
            <Button variant="secondary" size="lg" onClick={onDone}>{t('devices.approveServer.close')}</Button>
          </>
        )}
        {/* Read before (an earlier open), read again failed: what was read stays, said with a retry (❌ shown as current). */}
        {reading.state === 'value' && code !== null && !decided?.final
          ? <RefreshFailed reading={reading} /> : null}
        {view.kind === 'request' && <RequestBody view={view} onDecide={(approve) => decide(view.request, approve)} />}
        {view.kind === 'final' && (
          <>
            <h2 className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)]">{t(`devices.approveServer.final.${view.state}.title`)}</h2>
            <div className="text-[length:var(--font-body)] leading-relaxed text-[var(--text-secondary)]">
              {view.state === 'refused'
                ? <MachineLimitNotice refusal={view.refusal} />
                : t(`devices.approveServer.final.${view.state}.body`, { host: view.hostname ?? t('devices.approveServer.thisMachine') })}
            </div>
            <Button variant="secondary" size="lg" onClick={onDone} data-testid="server-login-approve-close">{t('devices.approveServer.close')}</Button>
          </>
        )}
      </div>
    </Sheet>
  )
}

function RequestBody({
  view,
  onDecide,
}: {
  view: Extract<View, { kind: 'request' }>
  onDecide: (approve: boolean) => void
}) {
  const { t } = useTranslation('settings')
  const { machine } = view.request
  const host = machine.hostname ?? t('devices.approveServer.thisMachine')
  const rows: Array<[string, string | null]> = [
    [t('devices.approveServer.system'), [PLATFORM_NAMES[machine.platform?.toLowerCase() ?? ''] ?? machine.platform, machine.arch].filter(Boolean).join(metadataSeparator()) || null],
    [t('devices.approveServer.user'), machine.user],
    [t('devices.approveServer.from'), view.request.requesterIp],
    [t('devices.approveServer.code'), view.request.code],
  ]
  return (
    <>
      <h2 className="text-[length:var(--font-title)] font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]">
        {t('devices.approveServer.ask', { host })}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-[var(--radius-control)] border border-[var(--border-color)] bg-[var(--bg-elevated)] px-4 py-3 text-[length:var(--font-body)]">
        {rows.filter(([, value]) => value).map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[var(--text-secondary)]">{label}</dt>
            <dd className="text-[var(--text-primary)] [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[length:var(--font-body)] leading-relaxed text-[var(--text-secondary)]">{t('devices.approveServer.warning')}</p>
      {view.error && <p className="text-[length:var(--font-body)] text-[var(--danger-fg)]" role="alert">{view.error}</p>}
      <Button variant="primary" size="lg" disabled={view.busy} onClick={() => onDecide(true)} data-testid="server-login-approve-allow">
        {t('devices.approveServer.allow', { host })}
      </Button>
      <Button variant="ghost" size="lg" disabled={view.busy} onClick={() => onDecide(false)} data-testid="server-login-approve-deny">
        {t('devices.approveServer.deny')}
      </Button>
    </>
  )
}
