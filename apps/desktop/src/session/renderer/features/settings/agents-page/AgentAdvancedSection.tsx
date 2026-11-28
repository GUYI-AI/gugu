import { isDeepEqual } from '@gugu/session-shared';
import { useForm } from '@tanstack/react-form';
import { ChevronRight, Plus, RotateCcw, Trash2 } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { parseEnvAssignmentPaste, replaceEnvEntryWithPaste } from '@renderer/lib/env-paste';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/lib/ui/select';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { Input } from '@renderer/lib/ui/input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { cn } from '@renderer/utils/utils';
import { useAgentSettings } from '@renderer/lib/stores/use-agent-settings';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import type { ProviderCustomConfig } from '@shared/core/app-settings';
import { OutdatedSourceBadge } from './agent-status-badge';
import type { RegistryRow } from './installation-sources';

type EnvEntry = { key: string; value: string };

export interface AgentAdvancedSectionProps {
  agentId: string;
  children?: React.ReactNode;
  compact?: boolean;
  /** Always open, as one group of label | control rows: the agent details dialog's 高级设置 view. */
  panel?: boolean;
  /** 各下载源(含版本读数)。空数组 = 这一家只有一个下载点,那一项就不摆。 */
  registries: RegistryRow[];
  /** 用户手动指定的下载源;undefined = 自动(主进程按测速选源)。 */
  registry: string | undefined;
  onRegistryChange: (registry: string | undefined) => void;
}

function makeDefaultValues(cfg: ProviderCustomConfig | undefined) {
  return {
    extraArgs: cfg?.extraArgs ?? '',
    envEntries: cfg?.env
      ? (Object.entries(cfg.env).map(([key, value]) => ({ key, value })) as EnvEntry[])
      : ([] as EnvEntry[])
  };
}

/** Settings for this agent on the selected host. The details panel includes its source selector. */
export const AgentAdvancedSection = observer(function AgentAdvancedSection({
  agentId,
  children,
  compact = false,
  panel = false,
  registries,
  registry,
  onRegistryChange
}: AgentAdvancedSectionProps) {
  const [open, setOpen] = useState(false);
  const { translate } = useSessionMessages();
  const { value: storedConfig, isOverridden, isLoading, error: settingsError, retry: retrySettings, update, reset } = useAgentSettings(agentId);

  const form = useForm({ defaultValues: makeDefaultValues(storedConfig) });

  const lastStored = useRef(makeDefaultValues(storedConfig));
  // A blur saves one field while the next is already being edited. Apply a host refresh only to clean fields.
  useEffect(() => {
    if (isLoading) return;
    const next = makeDefaultValues(storedConfig);
    const draft = form.state.values;
    if (draft.extraArgs === lastStored.current.extraArgs) form.setFieldValue('extraArgs', next.extraArgs);
    if (isDeepEqual(draft.envEntries, lastStored.current.envEntries)) form.setFieldValue('envEntries', next.envEntries);
    lastStored.current = next;
  }, [isLoading, storedConfig, form]);

  const commit = useCallback(() => {
    const { extraArgs, envEntries } = form.state.values;
    const envRecord: Record<string, string> = {};
    for (const { key, value } of envEntries) {
      const k = key.trim();
      if (k && /^[A-Za-z_]\w*$/.test(k)) {
        envRecord[k] = value;
      }
    }

    const isAtDefaults = extraArgs.trim() === '' && envEntries.every((e) => !e.key.trim());

    if (isAtDefaults) {
      reset(undefined, {
        onError: (err) => log.error('Failed to reset agent config:', err)
      });
    } else {
      const config: ProviderCustomConfig = {
        ...(storedConfig ?? {}),
        extraArgs: extraArgs.trim() || undefined,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined
      };
      update(config, {
        onError: (err) => log.error('Failed to save agent config:', err)
      });
    }
  }, [form, storedConfig, reset, update]);

  const handleResetToDefaults = useCallback(() => {
    form.setFieldValue('extraArgs', '');
    form.setFieldValue('envEntries', []);
    reset(undefined, {
      onError: (err) => log.error('Failed to reset agent config:', err)
    });
  }, [form, reset]);

  const resetButton = isOverridden && (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('shrink-0 gap-1.5 text-xs', !panel && 'mr-6')}
      onClick={handleResetToDefaults}
    >
      <RotateCcw className="size-3.5" />
      {translate('agentsPage.resetToDefaults')}
    </Button>
  );
  // The details dialog (panel) shows the same rows as label | control columns, without hints or tooltips.
  const row = ({ label, info, hint, control, children: below, stack }: {
    label: React.ReactNode; info?: string; hint: string; control: React.ReactNode; children?: React.ReactNode; stack?: boolean;
  }) => panel ? (
    <SettingsRow
      className="!grid-cols-[auto_minmax(0,1fr)] ![grid-template-areas:'lead_body']"
      leading={<span className="w-20 text-sm text-foreground">{label}</span>}
    >
      <div className="flex">{control}</div>
      {below}
    </SettingsRow>
  ) : (
    <SettingsRow
      title={info ? <>{label}<InfoTooltip label={translate('agentsPage.moreInformation')} content={info} /></> : label}
      description={hint}
      stack={stack}
      control={control}
    >
      {below}
    </SettingsRow>
  );

  const registryRow = registries.length > 0 && row({
    label: translate('agentsPage.manualRegistry'),
    hint: translate('agentsPage.registryHint'),
    control: (
      <Select
        value={registry ?? ''}
        onValueChange={(value) =>
          onRegistryChange(value === '' ? undefined : String(value))
        }
      >
        <SelectTrigger
          className={panel ? 'w-auto' : 'w-[156px]'}
          aria-label={translate('agentsPage.manualRegistry')}
          data-testid="registry-trigger"
        >
          <SelectValue>
            {registries.find((r) => r.registry === registry)?.label ??
              translate('agentsPage.sourceAuto')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent align={panel ? 'start' : 'end'}>
          <SelectItem value="">{translate('agentsPage.sourceAuto')}</SelectItem>
          {registries.map((r) => (
            <SelectItem key={r.registry} value={r.registry} disabled={r.unusable}>
              <span>{r.label}</span>
              <span className="font-mono text-xs text-foreground-muted">
                {r.unusable
                  ? translate('agentsPage.sourceMissingPlatformBuild')
                  : r.loading
                    ? translate('agentsPage.sourceVersionChecking')
                    : r.version
                      ? `v${r.version}`
                      : translate('agentsPage.sourceVersionUnknown')}
              </span>
              {r.outdated && <OutdatedSourceBadge />}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ),
  });
  const argsRow = (
    <form.Field name="extraArgs">
      {(field) => row({
        label: <label htmlFor="agent-extraArgs">{translate('agentsPage.additionalParameters')}</label>,
        info: translate('agentsPage.extraArgsTooltip'),
        hint: translate('agentsPage.extraArgsHint'),
        stack: true,
        control: (
          <Input
            id="agent-extraArgs"
            className={cn('font-mono text-sm', panel ? 'w-full' : 'w-[184px]')}
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            onBlur={commit}
            placeholder={translate('agentsPage.additionalParametersPlaceholder')}
          />
        ),
      })}
    </form.Field>
  );
  const envRow = (
    <form.Field name="envEntries">
      {(field) => row({
        label: translate('agentsPage.environmentVariables'),
        info: translate('agentsPage.environmentVariablesTooltip'),
        hint: translate('agentsPage.envHint'),
        control: (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              field.handleChange([...field.state.value, { key: '', value: '' }])
            }
          >
            <Plus className="size-3.5" />
            {translate('agentsPage.addVariable')}
          </Button>
        ),
        children: field.state.value.map((entry, i) => (
          <div key={i} className="mt-2 flex min-w-0 items-center gap-2">
            <Input
              aria-label={translate('agentsPage.envKeyPlaceholder')}
              value={entry.key}
              placeholder={translate('agentsPage.envKeyPlaceholder')}
              className="min-w-0 flex-1 font-mono text-sm"
              onChange={(e) =>
                field.handleChange(
                  field.state.value.map((v, n) =>
                    n === i ? { ...v, key: e.target.value } : v
                  )
                )
              }
              onBlur={commit}
              onPaste={(e) => {
                const pasted = parseEnvAssignmentPaste(e.clipboardData.getData('text'));
                if (!pasted.length) return;
                e.preventDefault();
                field.handleChange(replaceEnvEntryWithPaste(field.state.value, i, pasted));
              }}
            />
            <Input
              aria-label={translate('agentsPage.envValuePlaceholder')}
              value={entry.value}
              placeholder={translate('agentsPage.envValuePlaceholder')}
              className="min-w-0 flex-1 font-mono text-sm"
              onChange={(e) =>
                field.handleChange(
                  field.state.value.map((v, n) =>
                    n === i ? { ...v, value: e.target.value } : v
                  )
                )
              }
              onBlur={commit}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={translate('agentsPage.removeEnvEntry')}
              onClick={() => {
                field.handleChange(field.state.value.filter((_, n) => n !== i));
                commit();
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        )),
      })}
    </form.Field>
  );

  if (panel) {
    return (
      <div className="space-y-2" data-testid="agent-advanced-panel">
        {children}
        <RefreshFailed error={settingsError} onRetry={retrySettings} />
        <SettingsGroup>
          {argsRow}
          {envRow}
          {registryRow}
        </SettingsGroup>
        {resetButton && <div className="flex justify-end">{resetButton}</div>}
      </div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="relative flex items-center justify-between gap-3">
        <CollapsibleTrigger
          type="button"
          data-testid="agent-advanced-trigger"
          className="flex w-full items-center justify-between text-sm font-semibold"
        >
          {translate(compact ? 'agentsPage.advanced' : 'agentsPage.advancedSettings')}
          <ChevronRight className={cn('absolute right-0 size-3.5 transition-transform', open && 'rotate-90')} />
        </CollapsibleTrigger>
        {resetButton}
      </div>
      <CollapsibleContent className="pt-2">
        {children}
        <RefreshFailed error={settingsError} onRetry={retrySettings} />
        <SettingsGroup>
          {registryRow}
          {argsRow}
          {envRow}
        </SettingsGroup>
      </CollapsibleContent>
    </Collapsible>
  );
});
