import { useState } from 'react'
import { readModel, useReadModel } from '../../lib/readModel'
import { Unknown } from '../ui/Unknown'
import { useTranslation } from 'react-i18next'
import { FILE_RETENTIONS, IMAGE_RETENTIONS, parseFileStorage, type FileStorage } from '@gugu/core/shared/fileStorage'
import { messageForUser } from '@/lib/userFacingError'
import { listMyDeviceProjects } from '../../lib/deviceProjects'
import { writeFileStorage } from '../../lib/fileStorage'
import { ownSettings } from '../../lib/ownSettings'
import { useAuth } from '../../store/auth'
import { Button } from '../ui/Button'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { FileStorageDashboard } from './FileStorageDashboard'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { RefreshFailed } from '../ui/RefreshFailed'

/**
 * 「文件存储与读取」(owner 10-27):全局设置里唯一的一处,一个人一份。owner 10-28 批的设计稿:上面是仪表盘
 * (FileStorageDashboard,只算自己上传的),下面一组设置,最后是普通群的说明。
 * 项目群那两行只给名下有绑了项目群的机器的人(别人机器上的项目群跟着那台机器主人的这一份走):
 * 「其他文件」二选一(owner 10-27):留在机器上、有人打开才临时传一份到云端(那份留多久跟着它) / 全部上传到云端。
 * ❌ 单独的「临时中转」开关:关掉它 = 留在机器上而别人永远读不到。全部上传时图片也不再到期,两个保留期都不给。
 * 「图片和标了临时的文件」:数据层图片与临时文件各一格(image_retention / temporary_retention),设置上一个控件,
 * 改一次写两格(owner 10-28)。临时文件在普通群里也生效,所以这一行人人都有。
 */
/**
 * Which of this account's machines carry a bound project group. The file storage itself is a key of the account's own
 * settings row (ownSettings, `user`): one copy of that row, ❌ a second reading of it here.
 */
const projectGroupMachines = readModel({
  name: 'projectGroupMachines',
  scope: 'account',
  read: async () => Object.entries(await listMyDeviceProjects()).filter(([, rows]) => rows.some((row) => row.chatId)).map(([deviceId]) => deviceId),
  persist: true,
})

export function FileStorageSection({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('settings')
  useSettingsDetail('file-storage', t('fileStorage.title'), onBack)
  const { user } = useAuth()
  const userId = user?.id
  const row = useReadModel(ownSettings, userId ? ['user'] : null)
  const machines = useReadModel(projectGroupMachines, userId ? [] : null)
  const state = row.state === 'value' && machines.state === 'value' ? { storage: parseFileStorage(row.value), machines: machines.value } : null
  const failure = row.state === 'error' ? row.error : machines.state === 'error' ? machines.error : null
  const loadFailed = failure ? messageForUser(failure) : ''
  const [saveFailed, setSaveFailed] = useState('')
  const load = () => { void ownSettings.refresh('user'); void projectGroupMachines.refresh() }

  // A save puts the row the server kept into ownSettings: every reader of that row (this page among them) sees it.
  const update = (change: Partial<FileStorage>) => {
    if (!userId || !state) return
    setSaveFailed('')
    writeFileStorage(userId, change).catch((cause: unknown) => { setSaveFailed(messageForUser(cause)); load() })
  }

  const ordinary = (
    <SettingsGroup title={t('fileStorage.ordinaryTitle')}>
      <SettingsRow description={t('fileStorage.ordinary')} />
    </SettingsGroup>
  )
  if (loadFailed) {
    return <SettingsPage><SettingsGroup title={t('fileStorage.projectTitle')}>
      <SettingsRow description={loadFailed} control={<Button variant="secondary" size="sm" onClick={load}>{t('fileStorage.retry')}</Button>} />
    </SettingsGroup></SettingsPage>
  }
  // Not read yet: the one row everybody has, its value a placeholder (the project rows come only with a bound machine).
  if (!state) return <SettingsPage><FileStorageDashboard /><SettingsGroup title={t('fileStorage.settingsTitle')}>
    <SettingsRow title={t('fileStorage.kept')} description={t('fileStorage.keptHint')} control={<Unknown className="h-[var(--control-h-md)] w-28" />} />
  </SettingsGroup>{ordinary}</SettingsPage>

  const { storage } = state
  const cloud = storage.proactive_upload
  const bound = state.machines.length > 0
  // One group of settings under the dashboard (owner 10-28 design): the project rows only for someone with a bound machine.
  const settings = (
    <SettingsGroup title={t('fileStorage.settingsTitle')}
      footer={<>
        {storage.image_retention !== storage.temporary_retention && <SettingsNote>{t('fileStorage.keptDiffer', {
          images: t(`fileStorage.retentions.${storage.image_retention}`), temporary: t(`fileStorage.retentions.${storage.temporary_retention}`) })}</SettingsNote>}
        {saveFailed && <SettingsNote tone="danger">{saveFailed}</SettingsNote>}
        <RefreshFailed error={(row.state === 'value' ? row.error : null) ?? (machines.state === 'value' ? machines.error : null)} onRetry={load} />
      </>}>
      {bound && <SettingsRow title={<label htmlFor="settings-file-mode">{t('fileStorage.files')}</label>}
        description={`${t(cloud ? 'fileStorage.filesCloudHint' : 'fileStorage.filesMachineHint')} ${t('fileStorage.machines')}`}
        control={(
          <select id="settings-file-mode" className="gg-settings-select" value={cloud ? 'cloud' : 'machine'}
            onChange={(event) => update(event.target.value === 'cloud' ? { proactive_upload: true } : { proactive_upload: false, temporary_transfer: true })}>
            <option value="machine">{t('fileStorage.filesMachine')}</option>
            <option value="cloud">{t('fileStorage.filesCloud')}</option>
          </select>
        )} />}
      {bound && !cloud && <SettingsRow title={<label htmlFor="settings-file-retention">{t('fileStorage.temporaryRetention')}</label>}
        description={t('fileStorage.temporaryRetentionHint')}
        control={(
          <select id="settings-file-retention" className="gg-settings-select" value={storage.retention}
            onChange={(event) => update({ retention: event.target.value as FileStorage['retention'] })}>
            {FILE_RETENTIONS.map((value) => <option key={value} value={value}>{t(`fileStorage.retentions.${value}`)}</option>)}
          </select>
        )} />}
      <SettingsRow title={<label htmlFor="settings-kept-retention">{t('fileStorage.kept')}</label>} description={t('fileStorage.keptHint')}
        control={(
          <select id="settings-kept-retention" className="gg-settings-select" value={storage.image_retention}
            onChange={(event) => { const value = event.target.value as FileStorage['image_retention']; update({ image_retention: value, temporary_retention: value }) }}>
            {IMAGE_RETENTIONS.map((value) => <option key={value} value={value}>{t(`fileStorage.retentions.${value}`)}</option>)}
          </select>
        )} />
    </SettingsGroup>
  )
  return (
    <SettingsPage data-testid="settings-file-storage">
      <FileStorageDashboard />
      {settings}
      {!bound && <SettingsNote>{t('fileStorage.noMachine')}</SettingsNote>}
      {ordinary}
    </SettingsPage>
  )
}
