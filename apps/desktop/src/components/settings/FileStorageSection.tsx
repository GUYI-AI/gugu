import { useState } from 'react'
import { refreshFailure, useReplica } from '../../lib/replica'
import { Unknown } from '../ui/Unknown'
import { useTranslation } from 'react-i18next'
import { FILE_RETENTIONS, TEMPORARY_RETENTIONS, parseFileStorage, type FileStorage } from '@gugu/core/shared/fileStorage'
import { messageForUser } from '@/lib/userFacingError'
import { writeFileStorage } from '../../lib/fileStorage'
import { ownSettings } from '../../lib/ownSettings'
import { devicesModel } from '../../store/devicesCache'
import { useAuth } from '../../store/auth'
import { Button } from '../ui/Button'
import { useSettingsDetail } from './SettingsDetailNavigation'
import { FileStorageDashboard } from './FileStorageDashboard'
import { SettingsGroup, SettingsNote, SettingsPage, SettingsRow } from './SettingsPrimitives'
import { RefreshFailed } from '../ui/RefreshFailed'
import { useMobileShell } from '@/hooks/useMobileShell'
import { SettingsChoice } from './SettingsChoice'

/**
 * 「文件存储与读取」(owner 10-27):全局设置里唯一的一处,一个人一份。owner 10-28 批的设计稿:上面是仪表盘
 * (FileStorageDashboard,只算自己上传的),下面一组设置,最后是普通群的说明。
 * 项目群那两行只给名下有绑了项目群的机器的人(别人机器上的项目群跟着那台机器主人的这一份走):
 * 「其他文件」二选一(owner 10-27):留在机器上、有人打开才临时传一份到云端(那份留多久跟着它) / 全部上传到云端。
 * ❌ 单独的「临时中转」开关:关掉它 = 留在机器上而别人永远读不到。全部上传时没有临时中转,不给它的保留期。
 * 「标了临时的文件」留多久(temporary_retention):在普通群里也生效,所以这一行人人都有。图片和别的文件一样,没有自己的一行。
 */
/**
 * The file storage is a key of the account's own settings row (ownSettings, `user`); which of this account's machines
 * carry a bound project group is read off the machines (the devices replica: each row carries the projects the account
 * records for it). One copy of each, ❌ a second reading of either here.
 */

export function FileStorageSection({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('settings')
  const mobile = useMobileShell()
  useSettingsDetail('file-storage', t('fileStorage.title'), onBack)
  const { user } = useAuth()
  const userId = user?.id
  const row = useReplica(ownSettings, userId ? ['user'] : null)
  const devices = useReplica(devicesModel, userId ? [] : null)
  const machines = devices.state === 'value' ? devices.value.filter((device) => device.projects?.some((project) => project.chatId)) : null
  // The projects of a machine not read this time are its earlier ones, marked (projects_error): said as a failed refresh.
  const projectsError = devices.state === 'value' ? devices.value.find((device) => device.projects_error)?.projects_error : undefined
  const state = row.state === 'value' && machines ? { storage: parseFileStorage(row.value), machines } : null
  const failure = row.state === 'error' ? row.error : devices.state === 'error' ? devices.error : null
  const loadFailed = failure ? messageForUser(failure) : ''
  const [saveFailed, setSaveFailed] = useState('')
  const load = () => { void ownSettings.refresh('user'); void devicesModel.refresh() }

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
        {saveFailed && <SettingsNote tone="danger">{saveFailed}</SettingsNote>}
        <RefreshFailed error={refreshFailure(row) ?? refreshFailure(devices) ?? (projectsError ? new Error(projectsError) : null)} onRetry={load} />
      </>}>
      {bound && <SettingsRow title={<label htmlFor="settings-file-mode">{t('fileStorage.files')}</label>}
        description={`${t(cloud ? 'fileStorage.filesCloudHint' : 'fileStorage.filesMachineHint')} ${t('fileStorage.machines')}`}
        control={<SettingsChoice id="settings-file-mode" label={t('fileStorage.files')} mobile={mobile} value={cloud ? 'cloud' : 'machine'}
          options={[
            { value: 'machine', label: t('fileStorage.filesMachine') },
            { value: 'cloud', label: t('fileStorage.filesCloud') },
          ]}
          onChange={value => update(value === 'cloud' ? { proactive_upload: true } : { proactive_upload: false, temporary_transfer: true })} />} />}
      {bound && !cloud && <SettingsRow title={<label htmlFor="settings-file-retention">{t('fileStorage.temporaryRetention')}</label>}
        description={t('fileStorage.temporaryRetentionHint')}
        control={<SettingsChoice id="settings-file-retention" label={t('fileStorage.temporaryRetention')} mobile={mobile} value={storage.retention}
          options={FILE_RETENTIONS.map(value => ({ value, label: t(`fileStorage.retentions.${value}`) }))}
          onChange={retention => update({ retention })} />} />}
      <SettingsRow title={<label htmlFor="settings-kept-retention">{t('fileStorage.kept')}</label>} description={t('fileStorage.keptHint')}
        control={<SettingsChoice id="settings-kept-retention" label={t('fileStorage.kept')} mobile={mobile} value={storage.temporary_retention}
          options={TEMPORARY_RETENTIONS.map(value => ({ value, label: t(`fileStorage.retentions.${value}`) }))}
          onChange={temporary_retention => update({ temporary_retention })} />} />
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
