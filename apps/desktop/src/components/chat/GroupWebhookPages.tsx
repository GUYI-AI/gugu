import { useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Plus } from '@/lib/icons'
import { formatCalendarDay } from '@/i18n/format'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { useBackLayer } from '../ui/sheetStack'
import { useToast } from '../toastContext'
import { WebhookAvatar } from './MessageSenderAvatar'
import { WebhookTargetChecklist, WebhookTargetsSummary } from './WebhookTargets'
import { SettingsToggleRow } from './groupSettingsUi'
import { settingsDangerRowStyle, settingsErrorStyle, settingsReadOnlyBoxStyle, settingsRowSubtitleStyle, settingsRowTitleStyle, settingsSectionLabelStyle } from './groupSettingsStyles'
import { copyTextWithFeedback } from '../../lib/copyTextWithFeedback'
import { GROUP_WEBHOOK_NAME_MAX, GROUP_WEBHOOK_TARGET_MAX, groupWebhookUrl, pickableTargets, type GroupWebhook, type WebhookMember } from '../../lib/groupWebhooks'
import type { GroupWebhooksState } from './useGroupWebhooks'

// #3934 群管理 → 外部通知 → Webhook:列表一页、每个 Webhook 一页(设计 gugu-dev#1529 的界面稿)。
// owner 11-26 定「随时复制」:详情页一直显示完整地址和「复制地址」;重置换新地址,旧地址立刻失效。
// 指向(21:28)在建时和详情页里设,存在 Webhook 上;不指向就按收听规则。

type Head = (title: ReactNode, action?: ReactNode) => ReactNode

const firstSectionStyle: CSSProperties = { ...settingsSectionLabelStyle, marginTop: 0 }
const introStyle: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--muted-fg)', lineHeight: 1.6, margin: '0 0 8px' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, margin: '0 -8px', padding: '10px 8px', borderRadius: 'var(--radius-control)', cursor: 'pointer' }
const rowTextStyle: CSSProperties = { flex: 1, minWidth: 0 }
const rowNameStyle: CSSProperties = { fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
const rowLineStyle: CSSProperties = { color: 'var(--muted-fg)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
const emptyStyle: CSSProperties = { textAlign: 'center', padding: '40px 8px 24px', color: 'var(--muted-fg)', display: 'flex', flexDirection: 'column', alignItems: 'center' }
const hintStyle: CSSProperties = { fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', color: 'var(--muted-fg)', marginTop: 6 }
const urlStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-control)', background: 'var(--bg-elevated)', padding: '6px 6px 6px 10px' }
const monoStyle: CSSProperties = { fontFamily: 'var(--font-family-mono)', fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', overflowWrap: 'anywhere', wordBreak: 'break-all' }
const urlCodeStyle: CSSProperties = { ...monoStyle, flex: 1, minWidth: 0, color: 'var(--text-primary)' }
const exampleStyle: CSSProperties = { ...settingsReadOnlyBoxStyle, ...monoStyle, whiteSpace: 'pre-wrap' }
const recordStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '84px 1fr', rowGap: 6, color: 'var(--muted-fg)', padding: '12px 0' }
const recordValueStyle: CSSProperties = { color: 'var(--text-primary)', minWidth: 0, overflowWrap: 'anywhere' }
const offTagStyle: CSSProperties = { fontWeight: 400 }
const rowNameTextStyle: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const emptyTitleStyle: CSSProperties = { ...settingsRowTitleStyle, margin: '12px 0 6px' }
const createTargetsLabelStyle: CSSProperties = { ...settingsRowTitleStyle, marginTop: 8 }
const dialogPopupClass = 'pointer-events-auto flex w-full max-w-[440px] flex-col overflow-hidden rounded-[var(--radius-dialog)] border border-[var(--border)] bg-[var(--card)] text-[length:var(--font-body)] text-[var(--text-primary)] shadow-[var(--shadow-dialog)] outline-none'

const when = (iso: string | null) => (iso ? formatCalendarDay(iso, { withTime: true }) : null)

export function GroupWebhookList({ webhooks, members, head, bodyStyle, onOpen }: {
  webhooks: GroupWebhooksState
  members: readonly WebhookMember[]
  head: Head
  bodyStyle: CSSProperties
  onOpen: (webhookId: string) => void
}) {
  const { t } = useTranslation('messaging')
  const [adding, setAdding] = useState(false)
  const { hooks } = webhooks
  const add = (variant: 'primary' | 'secondary') => (
    <Button variant={variant} className={variant === 'secondary' ? 'w-full' : undefined} data-testid="group-webhook-add" onClick={() => setAdding(true)}><Plus size={14} />{t('group.webhooks.add')}</Button>
  )
  return (
    <>
      {head(t('group.webhooks.title'))}
      <div style={bodyStyle} data-testid="group-webhook-list">
        <p style={introStyle}>{t('group.webhooks.intro')}</p>
        {hooks === null ? null : hooks.length === 0 ? (
          <div style={emptyStyle}>
            <WebhookAvatar size={44} />
            <div style={emptyTitleStyle}>{t('group.webhooks.emptyTitle')}</div>
            <div>{t('group.webhooks.emptyBody')}</div>
            <div className="mt-4">{add('primary')}</div>
          </div>
        ) : (
          <>
            {hooks.map((hook) => (
              <div key={hook.id} className="gg-row" role="button" tabIndex={0} data-testid="group-webhook-row" style={rowStyle} onClick={() => onOpen(hook.id)}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(hook.id) } }}>
                <WebhookAvatar size={36} />
                <div style={rowTextStyle}>
                  <div style={rowNameStyle}>
                    <span style={rowNameTextStyle}>{hook.name}</span>
                    {hook.disabledAt ? <Chip appearance="filled" style={offTagStyle}>{t('group.webhooks.disabledTag')}</Chip> : null}
                  </div>
                  <div style={rowLineStyle}>{hook.disabledAt ? t('group.webhooks.disabledLine')
                    : hook.lastUsedAt ? t('group.webhooks.lastUsed', { time: when(hook.lastUsedAt) }) : t('group.webhooks.neverUsed')}</div>
                </div>
              </div>
            ))}
            <div className="mt-3">{add('secondary')}</div>
          </>
        )}
        {webhooks.error ? <div role="alert" style={settingsErrorStyle}>{webhooks.error}</div> : null}
      </div>
      {adding ? <WebhookCreateDialog webhooks={webhooks} members={members} onClose={() => setAdding(false)} onCreated={(hook) => { setAdding(false); onOpen(hook.id) }} /> : null}
    </>
  )
}

export function GroupWebhookDetail({ webhooks, members, webhookId, head, bodyStyle, onDeleted }: {
  webhooks: GroupWebhooksState
  members: readonly WebhookMember[]
  webhookId: string
  head: Head
  bodyStyle: CSSProperties
  onDeleted: () => void
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const hook = webhooks.hooks?.find((entry) => entry.id === webhookId) ?? null
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<'reset' | 'delete' | null>(null)
  const [targetDraft, setTargetDraft] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  if (!hook) {
    return <>{head(t('group.webhooks.title'))}<div style={bodyStyle}>
      {webhooks.hooks ? <div style={settingsRowSubtitleStyle}>{t('group.webhooks.missing')}</div> : null}
      {webhooks.error ? <div role="alert" style={settingsErrorStyle}>{webhooks.error}</div> : null}
    </div></>
  }
  const url = groupWebhookUrl(hook.token)
  const commitName = () => {
    const next = nameDraft?.trim()
    setNameDraft(null)
    if (!next || next === hook.name) return
    void webhooks.update(hook, { name: next }).then((row) => { if (row) toast(t('group.webhooks.renamed'), 'success') })
  }
  const confirm = async () => {
    setBusy(true)
    const row = confirming === 'reset' ? await webhooks.rotate(hook) : await webhooks.remove(hook)
    setBusy(false)
    setConfirming(null)
    if (!row) return
    toast(t(confirming === 'reset' ? 'group.webhooks.resetDone' : 'group.webhooks.deleted'), 'success')
    if (confirming === 'delete') onDeleted()
  }
  const saveTargets = async () => {
    if (!targetDraft) return
    setBusy(true)
    const row = await webhooks.update(hook, { targetUserIds: targetDraft })
    setBusy(false)
    if (!row) return
    setTargetDraft(null)
    toast(t('group.webhooks.targetsSaved'), 'success')
  }
  return (
    <>
      {head(hook.name)}
      <div style={bodyStyle} data-testid="group-webhook-detail">
        <div style={firstSectionStyle}>{t('group.webhooks.name')}</div>
        <Field.Root>
          <Field.Input aria-label={t('group.webhooks.name')} data-testid="group-webhook-name" maxLength={GROUP_WEBHOOK_NAME_MAX}
            value={nameDraft ?? hook.name} onChange={(event) => setNameDraft(event.target.value)} onBlur={commitName}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />
        </Field.Root>
        <div style={hintStyle}>{t('group.webhooks.nameHint')}</div>

        <div style={settingsSectionLabelStyle}>{t('group.webhooks.address')}</div>
        <div style={urlStyle}>
          <code style={urlCodeStyle} data-testid="group-webhook-url">{url}</code>
          <Button variant="secondary" size="sm" data-testid="group-webhook-copy"
            onClick={() => { void copyTextWithFeedback(url).then(() => toast(t('group.webhooks.copied'), 'success'), () => {}) }}>
            <Copy size={14} />{t('group.webhooks.copy')}
          </Button>
        </div>
        <div style={hintStyle}>{t('group.webhooks.addressHint')}</div>
        <div className="mt-3"><Button variant="secondary" size="sm" data-testid="group-webhook-reset" onClick={() => setConfirming('reset')}>{t('group.webhooks.reset')}</Button></div>

        <div style={settingsSectionLabelStyle}>{t('group.webhooks.sectionSend')}</div>
        <SettingsToggleRow title={t('group.webhooks.enabled')} ariaLabel={t('group.webhooks.enabled')}
          description={hook.disabledAt ? t('group.webhooks.enabledOff') : t('group.webhooks.enabledOn')}
          checked={!hook.disabledAt} onChange={(next) => { void webhooks.setDisabled(hook, !next) }} />

        <div style={settingsSectionLabelStyle}>{t('group.webhooks.targets')}</div>
        <WebhookTargetsSummary hook={hook} members={members} onEdit={() => setTargetDraft(pickableTargets(hook, members))} />

        <div style={settingsSectionLabelStyle}>{t('group.webhooks.sectionRecord')}</div>
        <div style={recordStyle}>
          <span>{t('group.webhooks.createdBy')}</span><span style={recordValueStyle}>{hook.createdByName ?? t('group.webhooks.creatorGone')}</span>
          <span>{t('group.webhooks.createdAt')}</span><span style={recordValueStyle}>{when(hook.createdAt)}</span>
          <span>{t('group.webhooks.lastUsedAt')}</span><span style={recordValueStyle}>{when(hook.lastUsedAt) ?? t('group.webhooks.neverUsed')}</span>
        </div>

        <div style={settingsSectionLabelStyle}>{t('group.webhooks.sectionHow')}</div>
        <div style={exampleStyle}>{`curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text":"${t('group.webhooks.exampleText')}"}'`}</div>
        <div style={hintStyle}>{t('group.webhooks.howHint')}</div>

        {webhooks.error ? <div role="alert" style={settingsErrorStyle}>{webhooks.error}</div> : null}
        <Button variant="ghost" data-testid="group-webhook-delete" className="gg-row w-full border-0 leading-[var(--lh-body)]" style={settingsDangerRowStyle} onClick={() => setConfirming('delete')}>{t('group.webhooks.delete')}</Button>
      </div>
      {confirming ? (
        <WebhookDialog testId={`group-webhook-${confirming}-confirm`} onClose={() => setConfirming(null)}
          title={t(confirming === 'reset' ? 'group.webhooks.resetTitle' : 'group.webhooks.deleteTitle', { name: hook.name })}
          description={t(confirming === 'reset' ? 'group.webhooks.resetBody' : 'group.webhooks.deleteBody')}
          actions={<>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" disabled={busy} data-testid="group-webhook-confirm" onClick={() => { void confirm() }}>{t(confirming === 'reset' ? 'group.webhooks.resetConfirm' : 'group.webhooks.deleteConfirm')}</Button>
          </>} />
      ) : null}
      {targetDraft ? (
        <WebhookDialog testId="group-webhook-targets-dialog" onClose={() => setTargetDraft(null)} title={t('group.webhooks.targetsTitle')}
          description={t('group.webhooks.targetsBody', { max: GROUP_WEBHOOK_TARGET_MAX })}
          body={<>
            <WebhookTargetChecklist members={members} selected={targetDraft} onChange={setTargetDraft} />
            {webhooks.error ? <div role="alert" style={settingsErrorStyle}>{webhooks.error}</div> : null}
          </>}
          actions={<>
            <Button variant="secondary" disabled={busy} onClick={() => setTargetDraft(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy} data-testid="group-webhook-targets-save" onClick={() => { void saveTargets() }}>{t('group.webhooks.targetsSave')}</Button>
          </>} />
      ) : null}
    </>
  )
}

function WebhookCreateDialog({ webhooks, members, onClose, onCreated }: {
  webhooks: GroupWebhooksState
  members: readonly WebhookMember[]
  onClose: () => void
  onCreated: (hook: GroupWebhook) => void
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const create = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    const row = await webhooks.create(name.trim(), targets)
    setBusy(false)
    if (!row) return
    toast(t('group.webhooks.created'), 'success')
    onCreated(row)
  }
  return (
    <WebhookDialog testId="group-webhook-create" onClose={onClose} title={t('group.webhooks.createTitle')} description={t('group.webhooks.createBody')}
      body={<>
        <Field.Root className="mt-1">
          <Field.Label>{t('group.webhooks.name')}</Field.Label>
          <Field.Input autoFocus data-testid="group-webhook-create-name" maxLength={GROUP_WEBHOOK_NAME_MAX} placeholder={t('group.webhooks.namePlaceholder')}
            value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void create() }} />
        </Field.Root>
        <div style={hintStyle}>{t('group.webhooks.createNameHint')}</div>
        <div style={createTargetsLabelStyle}>{t('group.webhooks.targetsOptional')}</div>
        <WebhookTargetChecklist members={members} selected={targets} onChange={setTargets} />
        <div style={hintStyle}>{t('group.webhooks.targetsHint')}</div>
        {webhooks.error ? <div role="alert" style={settingsErrorStyle}>{webhooks.error}</div> : null}
      </>}
      actions={<>
        <Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={busy || !name.trim()} data-testid="group-webhook-create-submit" onClick={() => { void create() }}>{t('group.webhooks.create')}</Button>
      </>} />
  )
}

function WebhookDialog({ testId, title, description, body, actions, onClose }: {
  testId: string
  title: string
  description: string
  body?: ReactNode
  actions: ReactNode
  onClose: () => void
}) {
  useBackLayer(onClose, true)
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[var(--z-modal)] bg-[var(--bg-overlay-soft)]" />
        <Dialog.Viewport className="pointer-events-none fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-6">
          <Dialog.Popup data-testid={testId} className={dialogPopupClass}>
            <div className="flex flex-col gap-3 p-6">
              <Dialog.Title className="text-[length:var(--font-title)] font-medium">{title}</Dialog.Title>
              <Dialog.Description className="leading-relaxed text-[var(--text-secondary)]">{description}</Dialog.Description>
              {body}
            </div>
            <div className="flex justify-end gap-2 px-6 pb-6">{actions}</div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
