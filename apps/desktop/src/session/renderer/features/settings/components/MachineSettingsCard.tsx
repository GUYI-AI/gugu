import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { Input } from '@renderer/lib/ui/input'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { PRODUCT_NAME } from '@shared/app-identity'
import { DeviceSettingsNotice } from './DeviceSettingsScope'
import { SettingSwitch, SettingValue } from './SettingControls'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { DeviceScopePicker, DeviceScopeStatus } from '@renderer/features/remote-hosts/device-scope-picker'
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store'
import { EnableTmuxRow } from './SessionSettingsRows'
import { terminalShown, useTerminalEnabled } from '../use-terminal-enabled'

export function MachineSettingsCard() {
  const localProject = useAppSettingsKey('localProject')
  const { translate } = useSessionMessages()
  // tmux 是终端的事:「终端」开关(本机,设置 → 通用)关着就不列。
  const terminalEnabled = useTerminalEnabled()

  return (
    <SettingsGroup
      title={
        <span className="flex min-w-0 items-center gap-2">
          <DeviceScopePicker store={settingsDeviceStore} />
          <DeviceScopeStatus store={settingsDeviceStore} />
        </span>
      }
    >
      {/* 看的是别的机器(#6264):离线 / 太旧时说一句,下面照旧画、一起灰。 */}
      <DeviceSettingsNotice
        error={localProject.settings.state === 'error' ? localProject.settings.error : null}
        hasData={localProject.settings.state === 'value'}
      />
      <SettingsRow
        title={translate('repository.defaultProjectsDirectory')}
        control={
          <SettingValue reading={localProject.settings} placeholder="h-8 w-72">
            {({ value }) => (
              <Input
                key={value.defaultProjectsDirectory}
                defaultValue={value.defaultProjectsDirectory}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim()
                  if (next && next !== value.defaultProjectsDirectory)
                    localProject.update({ defaultProjectsDirectory: next })
                }}
                aria-label={translate('repository.defaultProjectsDirectory')}
                disabled={localProject.isSaving || localProject.unavailable}
                className="w-72"
              />
            )}
          </SettingValue>
        }
      />
      <SettingsRow
        title={translate('repository.autoGitignore')}
        description={translate('repository.autoGitignoreDescription', { appName: PRODUCT_NAME })}
        control={
          <SettingSwitch
            api={localProject}
            field="writeAgentConfigToGitIgnore"
            resetLabel={translate('reset.on')}
            label={translate('repository.autoGitignoreToggle')}
          />
        }
      />
      {terminalShown(terminalEnabled) ? <EnableTmuxRow /> : null}
    </SettingsGroup>
  )
}
