import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';

const SidebarMetadataSettingsCard: React.FC = () => {
  const {
    value: interfaceSettings,
    update,
    isLoading,
    isSaving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('interface');
  const { translate } = useSessionMessages();

  const busy = isLoading || isSaving;
  const showAgentNameOnHover = interfaceSettings?.showLeftSidebarAgentNameOnHover ?? true;

  return (
    <SettingsGroup>
      {/* #2548 「二级分类」(showLeftSidebarStateGroups) is gone: the old project tree it grouped was removed, and a switch
          that does nothing ❌ renders. The settings key stays readable for saved settings. */}
      {/* #5818 指针压到会话行上,这一行就地变成它的 agent 名字。给开关是因为它换掉的是用户正在读的
          那一行的**内容**,不是多画一个角标 —— 有人要的就是「我扫的是标题,别在我眼皮底下变」
          (owner 2026-09-18)。默认开。 */}
      <SettingsRow
        title={translate('sidebarMeta.agentNameOnHover')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('showLeftSidebarAgentNameOnHover')}
              defaultLabel={translate('reset.on')}
              onReset={() => resetField('showLeftSidebarAgentNameOnHover')}
              disabled={busy}
            />
            <Switch
              checked={showAgentNameOnHover}
              onCheckedChange={(checked) => update({ showLeftSidebarAgentNameOnHover: checked })}
              disabled={busy}
              aria-label={translate('sidebarMeta.agentNameOnHoverToggle')}
            />
          </>
        }
      />
    </SettingsGroup>
  );
};

export default SidebarMetadataSettingsCard;
