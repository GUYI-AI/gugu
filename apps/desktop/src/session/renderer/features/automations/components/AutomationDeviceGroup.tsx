import { observer } from 'mobx-react-lite';
import { useId, useState, type ReactNode } from 'react';
import { Collapse } from '@/components/ui/Collapse';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { Unknown } from '@/components/ui/Unknown';
import { ChevronDown, ChevronRightIcon, Cloud, Monitor, Power, Server } from '@/lib/icons';
import { refreshFailure } from '@/lib/replica';
import { DeviceScopeNoticeLine } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Sheet, SheetContent } from '@renderer/lib/ui/sheet';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { Automation } from '@shared/core/automations/automation';
import { formatAutomationError } from '../automation-run-format';
import { useAutomationsHost } from '../automations-host';
import { useAutomations } from '../use-automations';
import { AutomationDetailView } from './AutomationDetailView';
import { AutomationsList } from './AutomationsList';

export const AutomationDeviceGroup = observer(function AutomationDeviceGroup({
  label,
  kind,
  search,
  emptyState,
}: {
  label: string;
  kind?: 'computer' | 'server' | 'cloudComputer';
  search: string;
  emptyState?: ReactNode;
}) {
  const host = useAutomationsHost();
  const { automations, retry, toggleEnabled, destroy } = useAutomations();
  const { translate } = useSessionMessages();
  const { navigate } = useNavigate();
  const { params, setParams } = useParams('automations');
  const showConfirm = useShowModal('confirmActionModal');
  const [expanded, setExpanded] = useState(true);
  const [inactiveExpanded, setInactiveExpanded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);
  const groupId = useId();
  const inactiveId = useId();

  const data = automations.state === 'value' ? automations.value : null;
  const deviceId = host.remote?.deviceId;
  const cloud = remoteHostsStore.cloudScope(deviceId);
  const asleep = host.remote?.online === false && cloud?.state === 'asleep';
  const notice = deviceScopeNotice({
    remote: host.remote,
    error: refreshFailure(automations),
    hasData: data !== null,
    now: Date.now(),
    cloud: asleep ? null : cloud,
  }, translate);
  const readOnly = notice?.readOnly ?? false;
  const offline = host.remote?.online === false;
  const status = offline ? (
    asleep ? translate('machinePicker.asleep') :
    cloud?.state === 'wake-failed' ? translate('machinePicker.wakeFailed') :
    cloud?.state === 'waking' ? translate('machinePicker.waking') :
    translate('machinePicker.offline')
  ) : null;
  const DeviceIcon = kind === 'cloudComputer' ? Cloud : kind === 'server' ? Server : Monitor;
  const query = search.trim().toLowerCase();
  const matches = data?.filter((automation) => automation.name.toLowerCase().includes(query));
  const enabled = matches?.filter((automation) => automation.enabled) ?? [];
  const inactive = matches?.filter((automation) => !automation.enabled) ?? [];
  const liveAutomation = params.automationId && params.automationDeviceId === deviceId
    ? data?.find((automation) => automation.id === params.automationId) ?? null
    : null;

  function openDetails(automation: Automation) {
    navigate('automations', { automationId: automation.id, automationDeviceId: deviceId });
  }

  function closeDetails() {
    setParams({ automationId: undefined, automationDeviceId: undefined });
  }

  function handleToggleEnabled(automation: Automation, enabled: boolean) {
    if (!readOnly) toggleEnabled.mutate({ id: automation.id, enabled });
  }

  function handleDelete(automation: Automation) {
    setPendingDelete(automation);
    closeDetails();
  }

  function handleSheetOpenChangeComplete(open: boolean) {
    if (open || !pendingDelete) return;

    // The sheet is modal and makes sibling portals inert. Wait until it has fully closed before
    // opening the global confirmation dialog so that the dialog remains interactive.
    const automation = pendingDelete;
    const restoreDetails = () => setParams({ automationId: automation.id, automationDeviceId: deviceId });
    setPendingDelete(null);
    showConfirm({
      title: translate('automations.deleteTitle'),
      description: translate('automations.deleteDescription', { name: automation.name }),
      confirmLabel: translate('automations.delete'),
      onSuccess: () => {
        void destroy
          .mutateAsync(automation.id)
          .catch(restoreDetails);
      },
      onClose: restoreDetails,
    });
  }


  const GroupChevron = expanded ? ChevronDown : ChevronRightIcon;
  const InactiveChevron = inactiveExpanded ? ChevronDown : ChevronRightIcon;

  return (
    <section aria-labelledby={`${groupId}-heading`} className="pb-2">
      <h2 id={`${groupId}-heading`}>
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg border border-border bg-background-secondary px-3 py-2 text-left text-sm font-semibold hover:bg-row-hover focus-visible:bg-row-hover"
          aria-expanded={expanded}
          aria-controls={groupId}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background-tertiary text-foreground-muted">
            <DeviceIcon aria-hidden="true" className="size-4" />
          </span>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {status && (
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-normal text-foreground-muted">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground-passive" />
              {status}
              {data !== null && <span className="sr-only">{translate('deviceScope.readOnlyCache')}</span>}
            </span>
          )}
          <GroupChevron aria-hidden="true" className="size-4 shrink-0 text-foreground-muted" />
        </button>
      </h2>
      <Collapse id={groupId} open={expanded} onOpenChange={setExpanded}>
        {notice ? (
          (!offline || cloud?.state === 'wake-failed') && <DeviceScopeNoticeLine notice={notice} onRetry={retry} noHeading />
        ) : <RefreshFailed reading={automations} />}
        {toggleEnabled.error && (
          <p role="alert" className="px-3 py-2 text-sm text-foreground-warning">
            {formatAutomationError(translate, toggleEnabled.error)}
          </p>
        )}
        {data === null && automations.state === 'unknown' && !notice && (
          <div className="px-4 py-3" aria-busy="true"><Unknown className="h-[3lh] w-full" /></div>
        )}
        {matches?.length === 0 && (!offline || !!query) && (
          data?.length === 0 && emptyState && !query && !notice ? emptyState : (
            <p className="px-3 py-2 text-sm text-foreground-muted">
              {translate(query ? 'automations.searchEmpty' : 'automations.deviceEmpty')}
            </p>
          )
        )}
        {enabled.length > 0 && (
          <AutomationsList automations={enabled} readOnly={readOnly} onEdit={openDetails} onToggleEnabled={handleToggleEnabled} />
        )}
        {inactive.length > 0 && (
          <>
            <h3 className="mx-3 mt-2 border-t border-border pt-2">
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground-muted hover:bg-row-hover focus-visible:bg-row-hover aria-expanded:bg-background-secondary"
                aria-expanded={inactiveExpanded}
                aria-controls={inactiveId}
                onClick={() => setInactiveExpanded(!inactiveExpanded)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background-tertiary">
                  <Power aria-hidden="true" className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">{translate('automations.inactiveGroup')}</span>
                <span className="rounded-md bg-background-tertiary px-1.5 py-0.5 text-xs tabular-nums">
                  {inactive.length.toLocaleString()}
                </span>
                <InactiveChevron aria-hidden="true" className="size-4 shrink-0" />
              </button>
            </h3>
            <Collapse id={inactiveId} open={inactiveExpanded} onOpenChange={setInactiveExpanded}>
              <AutomationsList automations={inactive} readOnly={readOnly} onEdit={openDetails} onToggleEnabled={handleToggleEnabled} />
            </Collapse>
          </>
        )}
      </Collapse>
      <Sheet
        open={liveAutomation !== null}
        onOpenChange={(open) => { if (!open) closeDetails(); }}
        onOpenChangeComplete={handleSheetOpenChangeComplete}
      >
        <SheetContent showCloseButton={false}>
          {liveAutomation && (
            <AutomationDetailView
              readOnly={readOnly}
              automation={liveAutomation}
              onClose={closeDetails}
              onDelete={handleDelete}
              onToggleEnabled={handleToggleEnabled}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
});
