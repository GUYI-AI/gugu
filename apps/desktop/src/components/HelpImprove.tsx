import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setErrorSummaryAllowed, useErrorSummaryConsent } from '../lib/errorSummaryConsent'
import { SettingsGroup, SettingsNote, SettingsRow, Toggle } from './settings/SettingsPrimitives'

/**
 * 「帮助改进咕咕」(owner 11-09 定方案 B):默认开,❌ 全局弹窗问。
 * 新用户在首登第一页「继续」下面看到一行勾选;所有人在「设置 → 通用」里是同一个开关。
 * 主进程读不到这个开关(手机、读失败)就整行不出现 —— 拨了没用的开关不画。
 */
function useHelpImprove() {
  const consent = useErrorSummaryConsent()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const change = (allowed: boolean) => {
    setSaving(true)
    setFailed(false)
    setErrorSummaryAllowed(allowed)
      .catch(() => setFailed(true))
      .finally(() => setSaving(false))
  }
  return {
    visible: consent.eligible && consent.context !== null,
    checked: consent.decision === 'allowed',
    saving,
    failed,
    change,
  }
}

/** 首登第一页,「继续」下面那一行。 */
export function HelpImproveCheck() {
  const { t } = useTranslation('main')
  const state = useHelpImprove()
  if (!state.visible) return null
  return (
    <>
      <label className="ta-onb-check">
        <input
          type="checkbox"
          checked={state.checked}
          disabled={state.saving}
          onChange={(event) => state.change(event.target.checked)}
          data-testid="first-run-help-improve"
        />
        <span>{t('firstRun.helpImprove')}</span>
      </label>
      {state.failed ? <p className="ta-onb-error" role="alert">{t('firstRun.helpImproveFailed')}</p> : null}
    </>
  )
}

/** 「设置 → 通用」里的同一个开关。 */
export function HelpImproveSettingGroup() {
  const { t } = useTranslation('main')
  const state = useHelpImprove()
  if (!state.visible) return null
  return (
    <SettingsGroup
      data-testid="settings-help-improve"
      footer={state.failed ? <SettingsNote tone="danger" role="alert">{t('settings.general.helpImproveFailed')}</SettingsNote> : undefined}
    >
      <SettingsRow
        title={t('settings.general.helpImprove')}
        description={t('settings.general.helpImproveDescription')}
        control={(
          <Toggle
            checked={state.checked}
            onChange={state.change}
            ariaLabel={t('settings.general.helpImprove')}
          />
        )}
      />
    </SettingsGroup>
  )
}
