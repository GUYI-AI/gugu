import React from 'react';
import { Unknown } from '@/components/ui/Unknown';
import { replica, useReplica } from '@/lib/replica';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { invokeOnMachine } from '@renderer/lib/ipc';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import {
  parseSessionTitleModelOptions,
  SESSION_TITLE_DEFAULT_MODEL,
  SESSION_TITLE_INSTRUCTIONS_MAX,
  SESSION_TITLE_MODELS_CHANNEL,
} from '@shared/core/sessions/session-title-namer';
import { DEFAULT_SESSION_AUTO_APPROVE } from '@shared/core/sessions/default-session-autonomy';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { DeviceSettingsNotice } from './DeviceSettingsScope';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingSwitch, SettingValue } from './SettingControls';
import { SettingsRow } from '@/components/settings/SettingsPrimitives';

export const AutoGenerateSessionNamesRow: React.FC = () => {
  const sessions = useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();
  return (
    <SettingsRow
      title={translate('taskDefaults.autoGenerateName')}
      control={<SettingSwitch api={sessions} field="autoGenerateName" resetLabel={translate('reset.on')} />}
    />
  );
};

/** Select 的值不能是 null:「不起名」用一个不会撞上模型 id 的哨兵。 */
const TITLE_MODEL_OFF = '__off__';

/**
 * #7337 候选:这个账号此刻在 Chat Completions 上能用的在售模型(档位不够的也列出来)。问的是 model-access,
 * 所以跟账号走、跨重启留一份;取不到(没登录、断网、没有宿主)就是读失败,下拉里只剩当前选的那个与「不起名」。
 */
const sessionTitleModels = replica({
  name: 'sessionTitleModels',
  scope: 'account',
  // async 包一层:没有宿主时 invoke 是**同步**抛的(浏览器测试、宿主还没接上),要让它也落进读失败。
  read: async () => parseSessionTitleModelOptions(await invokeOnMachine(null, SESSION_TITLE_MODELS_CHANNEL)),
  fresh: 10 * 60_000,
  persist: { maxBytes: 4096, maxEntries: 1 },
});

/**
 * #7337 用哪个平台模型给新会话起名(按积分计费);「不起名」= 标题留在 harness 起的名或第一句话上。
 * 档位不够的列出来但不能选。
 */
export const SessionTitleModelRow: React.FC = () => {
  const sessions = useAppSettingsKey('sessions');
  const catalog = useReplica(sessionTitleModels, []);
  const { translate } = useSessionMessages();
  // 能选的排前面,要会员的排后面(各自保持目录里的顺序):免费档一打开就看得到自己能用的那几个。目录没读到 = null。
  const ordered = catalog.state === 'value'
    ? [...catalog.value.filter((option) => !option.requiresMembership), ...catalog.value.filter((option) => option.requiresMembership)]
    : null;
  // 目录还没读到时,模型的名字画占位,❌ 画原始 id;读失败才只剩 id 可写。
  const labelOf = (value: string): React.ReactNode =>
    value === TITLE_MODEL_OFF
      ? translate('taskDefaults.titleModelOff')
      : ordered !== null
        ? ordered.find((option) => option.id === value)?.displayName ?? value
        : catalog.state === 'unknown' ? <Unknown className="w-24" /> : value;
  const defaultLabel = SESSION_TITLE_DEFAULT_MODEL;

  return (
    <SettingsRow
      title={translate('taskDefaults.titleModel')}
      description={translate('taskDefaults.titleModelDescription')}
      control={
        <SettingValue reading={sessions.settings} placeholder="h-8 w-[252px]">
          {({ value }) => {
            const current = value.titleModel;
            // Options: the catalog's, and the current choice when the catalog does not list it; catalog not read (or failed):
            // the current choice alone, with the catalog's state said below it.
            const own = current ? [{ id: current, requiresMembership: false }] : [];
            const listed: { id: string; requiresMembership: boolean }[] = ordered === null
              ? own
              : current && !ordered.some((option) => option.id === current) ? [...own, ...ordered] : ordered;
            return (
              <>
                <ResetToDefaultButton
                  visible={sessions.isFieldOverridden('titleModel')}
                  defaultLabel={ordered !== null ? ordered.find((option) => option.id === defaultLabel)?.displayName ?? defaultLabel : catalog.state === 'error' ? defaultLabel : undefined}
                  onReset={() => sessions.resetField('titleModel')}
                  disabled={sessions.isSaving}
                />
                <Select
                  value={current ?? TITLE_MODEL_OFF}
                  onValueChange={(next) => sessions.update({ titleModel: next === TITLE_MODEL_OFF ? null : String(next) })}
                  disabled={sessions.isSaving}
                >
                  <SelectTrigger className="w-[220px] shrink-0 gap-2">
                    <SelectValue>{labelOf(current ?? TITLE_MODEL_OFF)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end" className="min-w-max">
                    {listed.map((option) => (
                      <SelectItem key={option.id} value={option.id} disabled={option.requiresMembership}>
                        <span className="flex items-center gap-2">
                          {labelOf(option.id)}
                          {option.requiresMembership ? (
                            <span className="text-xs text-muted-foreground">{translate('taskDefaults.titleModelMembership')}</span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                    {catalog.state === 'unknown' ? <Unknown className="m-2 w-24" /> : catalog.state === 'error' ? (
                      <div className="p-2 text-sm text-muted-foreground">{translate('taskDefaults.titleModelsLoadFailed')}</div>
                    ) : null}
                    <SelectItem value={TITLE_MODEL_OFF}>{translate('taskDefaults.titleModelOff')}</SelectItem>
                  </SelectContent>
                </Select>
              </>
            );
          }}
        </SettingValue>
      }
    />
  );
};

/**
 * #7337 起名时追加给模型的风格要求(owner 选 A:只开放追加,不开放整段提示词)。失焦才存,❌ 每敲一个字写一次设置;
 * 选了「不起名」时这一行不可用。
 */
export const SessionTitleInstructionsRow: React.FC = () => {
  const sessions = useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();

  return (
    <SettingsRow
      title={translate('taskDefaults.titleInstructions')}
      description={translate('taskDefaults.titleInstructionsDescription')}
      control={
        <SettingValue reading={sessions.settings} placeholder="h-8 w-[252px]">
          {({ value }) => (
            <>
              <ResetToDefaultButton
                visible={sessions.isFieldOverridden('titleInstructions')}
                defaultLabel={translate('taskDefaults.titleInstructionsEmpty')}
                onReset={() => sessions.resetField('titleInstructions')}
                disabled={sessions.isSaving}
              />
              <Input
                key={value.titleInstructions}
                defaultValue={value.titleInstructions}
                maxLength={SESSION_TITLE_INSTRUCTIONS_MAX}
                placeholder={translate('taskDefaults.titleInstructionsPlaceholder')}
                aria-label={translate('taskDefaults.titleInstructions')}
                onBlur={(event) => {
                  const next = event.currentTarget.value.trim();
                  if (next !== value.titleInstructions) sessions.update({ titleInstructions: next });
                }}
                disabled={sessions.isSaving || value.titleModel === null}
                className="w-[220px] shrink-0"
              />
            </>
          )}
        </SettingValue>
      }
    />
  );
};

export const AutoApproveByDefaultRow: React.FC = () => {
  const sessions = useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();
  return (
    <SettingsRow
      title={translate('taskDefaults.autoApprove')}
      description={translate('taskDefaults.autoApproveDescription')}
      control={
        <SettingSwitch
          api={sessions}
          field="autoApproveByDefault"
          resetLabel={translate(DEFAULT_SESSION_AUTO_APPROVE ? 'reset.on' : 'reset.off')}
        />
      }
    />
  );
};

export const AutoTrustWorktreesRow: React.FC = () => {
  const sessions = useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();
  return (
    <SettingsRow
      title={
        <div className="flex items-center gap-1.5">
          {translate('taskDefaults.autoTrustWorktrees')}
          <InfoTooltip
            label={translate('taskDefaults.autoTrustWorktreesInfoLabel')}
            content={translate('taskDefaults.autoTrustWorktreesInfo')}
          />
        </div>
      }
      description={translate('taskDefaults.autoTrustWorktreesDescription')}
      control={<SettingSwitch api={sessions} field="autoTrustWorktrees" resetLabel={translate('reset.on')} />}
    />
  );
};

export const PreserveSessionNameCapitalizationRow: React.FC = () => {
  const sessions = useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();
  return (
    <SettingsRow
      title={translate('taskDefaults.preserveCapitalization')}
      description={translate('taskDefaults.preserveCapitalizationDescription')}
      control={<SettingSwitch api={sessions} field="preserveNameCapitalization" resetLabel={translate('reset.off')} />}
    />
  );
};

/** #3005 Claude Code 会话离开时赶在提示缓存过期前压缩;关掉对在跑的会话立即生效。 */
export const IdleCompactionRow: React.FC = () => {
  const sessions = useAppSettingsKey('sessions');
  const { translate } = useSessionMessages();
  return (
    <SettingsRow
      title={translate('taskDefaults.idleCompaction')}
      description={translate('taskDefaults.idleCompactionDescription')}
      control={<SettingSwitch api={sessions} field="idleCompaction" resetLabel={translate('reset.on')} />}
    />
  );
};

export const EnableTmuxRow: React.FC = () => {
  const project = useAppSettingsKey('project');
  const { translate } = useSessionMessages();
  return (
    <>
      <SettingsRow
        title={translate('taskDefaults.enableTmux')}
        description={translate('taskDefaults.enableTmuxDescription')}
        control={<SettingSwitch api={project} field="tmuxByDefault" resetLabel={translate('reset.off')} />}
      />
      <DeviceSettingsNotice
        error={project.settings.state === 'error' ? project.settings.error : null}
        hasData={project.settings.state === 'value'}
      />
    </>
  );
};
