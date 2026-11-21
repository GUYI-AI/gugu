import { messageForUser } from '@/lib/userFacingError';
// @@@5856 「agent 超过几个就全员转被动」这条线的设置行 —— 群和话题**共用这一个**。
//
// owner 2026-09-19 的裁决:「之前说是 5 个转为 passive, 这个数字可以放在设置中,而不是硬编码。
// 这个 5 个的 passive 不止可以适用于一个群内,群内的 topic 应该也是生效的,
// 不过群内的 topic 可以设置一个自定义个不一样的数,或者遵循群主规则。」
//
// 形状上只有**一个**控件,没有「跟随 / 自定义」的第二个开关:空 = 继承(话题跟来源那条线、群跟产品默认),
// 填了 = 以这个数为准。占位符里显示的就是此刻实际生效的数,所以「跟随的是多少」不用另开一行去说。
//
// 实际生效的那个数由 **DB 计算列** agent_flood_threshold_effective 给出,❌ 这里不写 COALESCE、
// ❌ 也不写死 5:界面显示的数必须和触发器判的数是同一个,否则用户照着界面改,改出来的行为对不上。
// 取不到就整行不画 —— 空得看得出是空,好过编一个像真的默认值。
//
// 自己取值、自己落库:来源设置统一管理群与话题,每条线复用同一控件,
// ❌ 不各抄一份取值/存值/回填的代码。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CSSProperties } from 'react'
import { useReplica } from '../../lib/replica'
import { groupSettings, writeGroupSettings } from './useGroupChatSettings'
import { Unknown } from '../ui/Unknown'
import { useToast } from '../toastContext'
import { parseAgentFloodThresholdDraft } from './agentFloodThresholdModels'

const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16,
  // 2026-09-22 design.md:行靠 padding 分隔、线只留在分区标题上 —— 这一行原来自带底线,在群管理里会和下一个分区标题叠成双线(#6418)。
  padding: '15px 0',
}
const TITLE_STYLE: CSSProperties = { fontSize: 'var(--font-body)', fontWeight: 500, color: 'var(--text-primary)' }
const HINT_STYLE: CSSProperties = {
  fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.5,
}
const VALUE_STYLE: CSSProperties = { fontSize: 'var(--font-body)', color: 'var(--text-tertiary)', flexShrink: 0 }
const INPUT_STYLE: CSSProperties = {
  width: 64, textAlign: 'right', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-control)',
  padding: '4px 8px', fontSize: 'var(--font-body)', color: 'var(--text-primary)',
  background: 'var(--bg-elevated)', outline: 'none', fontFamily: 'inherit', flexShrink: 0,
}

export function AgentFloodThresholdSetting({
  chatId,
  inherits,
  onSaved,
  revision = 0,
}: {
  chatId: string
  /** 这条线上面还有一条线可跟(话题有,群没有)——只影响那句说明的措辞。 */
  inherits: boolean
  onSaved?: () => void
  revision?: number
}) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const saving = useRef(false)
  const [busy, setBusy] = useState(false)
  // The group's settings reading the chat already holds (❌ a read of its own): `revision` asks for a fresh one.
  const reading = useReplica(groupSettings, [chatId])
  const seenRevision = useRef(revision)
  useEffect(() => {
    if (seenRevision.current === revision) return
    seenRevision.current = revision
    void groupSettings.refresh(chatId)
  }, [chatId, revision])
  const settings = reading.state === 'value' ? reading.value : null
  // ❌ 不静默:读不到就说读不到,失败本身也留在日志里。
  const failed = reading.state === 'error' ? messageForUser(reading.error) : ''
  const editable = settings?.can_manage === true
  const value = settings ? settings.agent_flood_threshold : null
  // null means no local edit; an empty string is the explicit inheritance draft.
  const [draft, setDraft] = useState<string | null>(null)

  const commit = useCallback(() => {
    if (!editable || saving.current) return
    const next = parseAgentFloodThresholdDraft(draft ?? (value === null ? '' : String(value)))
    // 收不下的输入就还原成上一个有效值 —— ❌ 不弹错、也 ❌ 不把半截输入存进去。
    if (next === undefined || next === value) { setDraft(null); return }
    saving.current = true
    setBusy(true)
    // The group's write rules (a read begun before this acknowledgement does not replace the saved value); the effective
    // value comes back with it (once a line has its own number it no longer follows the line above).
    writeGroupSettings(chatId, { agent_flood_threshold: next })
      .then(() => { setDraft(null); onSaved?.() })
      .catch((error: unknown) => {
        setDraft(null)
        toast(t('group.settings.agentFloodSaveFailed'), 'error', messageForUser(error))
      })
      .finally(() => { saving.current = false; setBusy(false) })
  }, [chatId, draft, value, editable, onSaved, toast, t])

  if (failed) return <p role="alert">{failed}</p>
  // Not read yet: the row's place is kept (❌ inserted later, pushing the rows below down).
  if (!settings) return <div style={ROW_STYLE} data-testid="agent-flood-threshold-row"><div><div style={TITLE_STYLE}>{t('group.settings.agentFloodThreshold')}</div><div style={HINT_STYLE}><Unknown className="w-40" /></div></div></div>
  const effective = settings.agent_flood_threshold_effective
  // Read, and the server has no effective value: no row, ❌ a default number that looks normal.
  if (effective === null) return null

  return (
    <div style={ROW_STYLE} data-testid="agent-flood-threshold-row" data-agent-flood-effective={effective}>
      <div>
        <div style={TITLE_STYLE}>{t('group.settings.agentFloodThreshold')}</div>
        <div style={HINT_STYLE}>
          {inherits
            ? t('group.settings.agentFloodThresholdInheritHint', { count: effective })
            : t('group.settings.agentFloodThresholdDefaultHint', { count: effective })}
        </div>
      </div>
      {editable ? (
        <input
          type="number"
          min={1}
          disabled={busy}
          inputMode="numeric"
          aria-label={t('group.settings.agentFloodThresholdAria')}
          data-testid="agent-flood-threshold-input"
          placeholder={String(effective)}
          value={draft ?? (value === null ? '' : String(value))}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          style={INPUT_STYLE}
        />
      ) : (
        <span style={VALUE_STYLE}>{effective}</span>
      )}
    </div>
  )
}
