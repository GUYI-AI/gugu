import { messageForUser } from '@/lib/userFacingError';
import { Crown } from '@/lib/icons'
import { useTheme } from '@/store/theme'
import { SessionUiTheme } from '../sessionpage/SessionUiTheme'
import { useState } from 'react'
import { useReplica, retryOf } from '../../lib/replica'
import { Unknown } from '../ui/Unknown'
import { useTranslation } from 'react-i18next'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { billingLinksAvailable, openBillingPage } from '../../lib/appLinks'
import { setPlatformModelHidden, type PlatformCatalogModel } from '../../lib/agentModelSelection'
import { platformModels } from '../../lib/agentModelReplicas'
import { rendererLogger } from '../../lib/log'
import { Button } from '../ui/Button'
import { SearchField } from '../ui/SearchField'
import { SettingsNote, SettingsPage, SettingsRow, Toggle } from './SettingsPrimitives'
import { RefreshFailed } from '../ui/RefreshFailed'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { Dialog, DialogContent, DialogContentArea, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { CustomModelsGroup, ModelProviderRow } from './CustomModelsGroup'
import { DeviceScopePicker, DeviceScopeStatus } from '@renderer/features/remote-hosts/device-scope-picker'
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store'
import './ModelSettings.css'

/**
 * 模型 pane(#7056)—— 照 Cursor 的 Settings › Models:列出咕咕提供的全部模型,开关决定**哪些出现在模型下拉里**。
 *
 * owner 2026-10-10 看着 Cursor 定的:下拉里只放点得中、跑得起来的;「升级解锁更多模型」与「自定义下拉里有哪些」
 * 都在这一页。从前把会员模型列进下拉、点它去开通 —— 原话「像是埋雷,让用户稍不留意就点到了他用不了的模型」。
 *
 *  - 用得了的一组:每条一个开关。关掉 = 下拉里不列(跟着账号走,手机、别的电脑一样)。只管显示,
 *    正在跑的会话不受影响,agent 自己起会话也照样能用(与 Cursor 同一语义)。
 *  - 要会员的一组(免费档才有):不给开关 —— 开了也用不了;一处「升级解锁」去网页面板。
 *
 * 存哪一格由 `model-access` 管(`set_model_hidden`),这里 ❌ 自己写 user_settings。
 * Custom provider records share the model page and each session binds its selected model.
 */
const paneLog = rendererLogger('settings/model-pane')

export function ModelSection({ addRequested, onAddClose }: { addRequested?: boolean; onAddClose?: () => void } = {}) {
  const { theme } = useTheme()
  return (
    <SettingsPage className="gg-model-page" data-testid={AUTOMATION_TEST_IDS.settingsModelPane}>
      <SessionUiTheme theme={theme} skin>
      <div className="flex min-w-0 items-center gap-2" data-testid="settings-model-machine">
        <DeviceScopePicker store={settingsDeviceStore} />
        <DeviceScopeStatus store={settingsDeviceStore} />
      </div>
      </SessionUiTheme>
      <CustomModelsGroup addRequested={addRequested} onAddClose={onAddClose} providedModels={<ProvidedModels />} />
    </SettingsPage>
  )
}

function ProvidedModels() {
  const { t } = useTranslation('settings')
  const { translate } = useSessionMessages()
  const [open, setOpen] = useState(false)
  const catalog = useReplica(platformModels, [])
  const canUpgrade = catalog.state === 'value' && catalog.value.some(model => model.enabled && model.requiresMembership) && billingLinksAvailable()
  return <>
    <ModelProviderRow icon={<img src={publicAssetPath('/assets/app/gugu-icon-small.png')} alt="" />}
      name={t('model.providerName')} manageLabel={translate('customModels.manageConnectionModels')}
      onManage={() => setOpen(true)} manageTestId="settings-model-provided-manage"
      endAction={canUpgrade ? <Button className="gg-model-icon-button" size="icon" variant="ghost"
        aria-label={translate('composer.platformModelUpgrade')} data-testid="settings-model-provided-upgrade" onClick={openBillingPage}>
        <Crown aria-hidden="true" className="size-4" />
      </Button> : undefined} />
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gg-model-dialog gg-provided-model-dialog sm:max-w-[480px]" data-testid="settings-model-provided-dialog">
        <DialogHeader><DialogTitle>{t('model.provided')}</DialogTitle></DialogHeader>
        <DialogContentArea><ProvidedModelCatalog /></DialogContentArea>
      </DialogContent>
    </Dialog>
  </>
}

function ProvidedModelCatalog() {
  const { t } = useTranslation('settings')
  const catalog = useReplica(platformModels, [])
  const models = catalog.state === 'value' ? catalog.value.filter((model) => model.enabled) : null
  const loadFailed = catalog.state === 'error' ? messageForUser(catalog.error) : ''
  const [saveFailed, setSaveFailed] = useState('')
  // 列表顶上一格搜索(Cursor 那页同款):按名字或 id 筛,两组一起筛。
  const [query, setQuery] = useState('')

  const toggle = (model: PlatformCatalogModel, shown: boolean) => {
    setSaveFailed('')
    // 先拨过去再存:开关的手感不该等一趟网络。存失败就说一句,并以服务端为准重读一遍 ——
    // ❌ 手动拨回点击那一刻的值:连拨几下时那个值早就旧了;模型刚好下架(404)时重读也让它从列表里消失。
    platformModels.set([], (current) => current?.map((entry) => (entry.id === model.id ? { ...entry, hidden: !shown } : entry)))
    setPlatformModelHidden(model.id, !shown).catch((cause: unknown) => {
      paneLog.error({ modelId: model.id, error: String(cause) }, 'saving model visibility failed')
      setSaveFailed(messageForUser(cause))
      void platformModels.refresh()
    })
  }

  const needle = query.trim().toLowerCase()
  // The two groups of what the search matches; null while the catalog is not read.
  const groups = models === null ? null : (() => {
    const matched = models.filter((model) =>
      !needle || model.displayName.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle))
    return { usable: matched.filter((model) => !model.requiresMembership).sort((a, b) => Number(a.hidden) - Number(b.hidden)), locked: matched.filter((model) => model.requiresMembership) }
  })()

  return (
    <>
      <SearchField value={query} onChange={event => setQuery(event.target.value)} placeholder={t('model.search')}
        clearLabel={t('model.searchClear')} onClear={() => setQuery('')} data-testid="settings-model-search" />
      {loadFailed ? <SettingsRow description={loadFailed} control={<Button variant="secondary" size="sm" onClick={retryOf(catalog)}>{t('model.retry')}</Button>} />
        : groups === null ? <Unknown className="h-24 w-full" /> : <>
          {catalog.state === 'value' ? <RefreshFailed reading={catalog} /> : null}
          {needle && groups.usable.length === 0 && groups.locked.length === 0 && <SettingsNote>{t('model.noMatch')}</SettingsNote>}
          <div className="gg-provided-model-list" role="region" aria-label={t('model.provided')} tabIndex={0}>
            <div data-testid="settings-model-usable">
              {groups.usable.map(model => <SettingsRow key={model.id} data-model-id={model.id} title={model.displayName}
                control={<Toggle checked={!model.hidden} onChange={shown => toggle(model, shown)} ariaLabel={t('model.toggleAria', { model: model.displayName })} />} />)}
            </div>
            {groups.locked.length > 0 && <div data-testid="settings-model-locked">
              <SettingsNote>{t('model.membersOnly')}</SettingsNote>
              {groups.locked.map(model => <SettingsRow key={model.id} data-model-id={model.id} title={model.displayName} />)}
            </div>}
          </div>
        </>}
      {saveFailed && <SettingsNote tone="danger">{saveFailed}</SettingsNote>}
    </>
  )
}
