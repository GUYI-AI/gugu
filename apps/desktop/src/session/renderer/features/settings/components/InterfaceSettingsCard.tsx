import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SettingSwitch } from './SettingControls';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { useSessionMessages } from '@renderer/localization/use-session-messages';


const InterfaceSettingsCard: React.FC = () => {
  const { translate } = useSessionMessages();
  const interfaceSettings = useAppSettingsKey('interface');

  return (
    <SettingsGroup>
      <SettingsRow
        title={translate('settings.contextBar')}
        description={translate('settings.contextBarDescription')}
        control={<SettingSwitch api={interfaceSettings} field="hideContextBar" resetLabel={translate('settings.contextBarShown')} />}
      />
      {/* owner 2026-09-05:归档谈不谈是一项设置。用户在确认框里勾了「不再询问」之后,
          没有别的地方能反悔 —— 这一行就是那条回头路。删除不在此列:不可撤销的动作,确认不是偏好。 */}
      <SettingsRow
        title={translate('settings.confirmBeforeArchive')}
        description={translate('settings.confirmBeforeArchiveDescription')}
        control={<SettingSwitch api={interfaceSettings} field="confirmBeforeArchive" resetLabel={translate('settings.confirmBeforeArchiveAsk')} />}
      />
      {/* owner 2026-09-23:「取消回合并发送」的确认与归档同一个形状 —— 确认框里勾「不再询问」,这里反悔。 */}
      <SettingsRow
        title={translate('settings.confirmBeforeCancelAndSend')}
        description={translate('settings.confirmBeforeCancelAndSendDescription')}
        control={<SettingSwitch api={interfaceSettings} field="confirmBeforeCancelAndSend" resetLabel={translate('settings.confirmBeforeArchiveAsk')} />}
      />
    </SettingsGroup>
  );
};

export default InterfaceSettingsCard;
