import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { deviceScopeTrayDevices, LOCAL_DEVICE_SCOPE } from '@renderer/features/remote-hosts/device-scope-store';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import { machineAcceptsWork, orderMachines } from '@renderer/features/remote-hosts/machine-choice';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { useParams } from '@renderer/lib/layout/navigation-provider';
import { Sheet, SheetContent } from '@renderer/lib/ui/sheet';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import { AutomationsHostProvider, createMachineAutomationsHost, LOCAL_AUTOMATIONS_HOST } from '../automations-host';
import type { BuiltinAutomationTemplate } from '../automation-template';
import { buildBuiltinAutomationCatalog } from '../builtin-catalog';
import { AutomationDeviceGroup } from './AutomationDeviceGroup';
import { AutomationsHeader } from './AutomationsHeader';
import { AutomationTemplatesEmptyState } from './AutomationTemplatesEmptyState';
import { CreateAutomationView } from './CreateAutomationView';

function DeviceAutomationProviders({ device, children }: { device: RemoteHostDevice | null; children: ReactNode }) {
  const remote = device ? {
    deviceId: device.id,
    deviceLabel: device.label,
    online: device.isOnline,
    lastSeenAt: device.lastSeenAt,
    hostKind: device.hostKind,
  } : null;
  return (
    <AutomationsHostProvider value={remote ? createMachineAutomationsHost(remote) : LOCAL_AUTOMATIONS_HOST}>
      <LibraryHostProvider value={machineLibraryHost(remote)}>{children}</LibraryHostProvider>
    </AutomationsHostProvider>
  );
}

export const AutomationsView = observer(function AutomationsView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { translate } = useSessionMessages();
  const { setParams } = useParams('automations');
  const [search, setSearch] = useState('');
  const [creation, setCreation] = useState<{ deviceId: string; template?: BuiltinAutomationTemplate } | null>(null);
  const templates = useMemo(() => buildBuiltinAutomationCatalog(translate), [translate]);

  useEffect(() => remoteHostsStore.start(), []);
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => !!element && !!rootRef.current?.contains(element),
    getCommands: () => [{ id: 'app.find', hideFromPalette: true, execute: () => searchRef.current?.focus() }],
  });

  const machines = orderMachines(deviceScopeTrayDevices(
    translate('task.deviceLocal'),
    [...remoteHostsStore.hosts.values()].map(({ device }) => ({
      device,
      connection: remoteHostsStore.connectionState(device.id),
    }))
  ));
  const target = machines.find((machine) => machine.id === creation?.deviceId);
  const targetDevice = target && !target.isLocal ? remoteHostsStore.device(target.id) : null;

  function openCreateSheet(template?: BuiltinAutomationTemplate) {
    setParams({ automationId: undefined, automationDeviceId: undefined });
    setCreation({ deviceId: LOCAL_DEVICE_SCOPE, template });
  }

  function closeCreateSheet() {
    setCreation(null);
  }

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="h-6 shrink-0 [-webkit-app-region:drag]" />
      <div className="mx-auto grid min-h-0 w-full max-w-4xl flex-1 grid-cols-1 gap-8">
        <div className="relative min-h-0 w-full min-w-0 overflow-y-auto px-8">
          <div className="@container w-full py-6">
            <AutomationsHeader searchInputRef={searchRef} search={search} onSearchChange={setSearch} onNewAutomation={() => openCreateSheet()} />
            <div className="mt-4 space-y-3">
              {machines.map((machine) => (
                <DeviceAutomationProviders key={machine.id} device={machine.isLocal ? null : remoteHostsStore.device(machine.id)}>
                  <AutomationDeviceGroup
                    label={machine.label}
                    kind={machine.kind}
                    collapsible={machines.length > 1}
                    search={search}
                    emptyState={machine.isLocal && machines.length === 1 ? (
                      <AutomationTemplatesEmptyState templates={templates} onSelectTemplate={openCreateSheet} />
                    ) : undefined}
                  />
                </DeviceAutomationProviders>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Sheet open={creation !== null} onOpenChange={(open) => { if (!open) closeCreateSheet(); }}>
        <SheetContent showCloseButton={false}>
          {creation && (
            <DeviceAutomationProviders key={creation.deviceId} device={targetDevice}>
              <CreateAutomationView
                readOnly={!target || !machineAcceptsWork(target) || (!target.isLocal && !targetDevice?.isOnline)}
                onClose={closeCreateSheet}
                onSaved={() => setCreation((current) => current === creation ? null : current)}
                initialTemplate={creation.template}
                devicePicker={machines.length > 1 || !target ? (
                  <MachinePicker
                    machines={machines}
                    selectedId={creation.deviceId}
                    onSelect={(deviceId) => setCreation({ ...creation, deviceId })}
                    testId="automation-create-machine-picker"
                  />
                ) : null}
              />
            </DeviceAutomationProviders>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
});
