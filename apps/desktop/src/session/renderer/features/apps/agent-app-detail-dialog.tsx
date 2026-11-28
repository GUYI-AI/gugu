import { useId, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useInstalledMachines } from '@renderer/features/extensions/installed/use-installed-machines';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { MachinePicker } from '@renderer/features/remote-hosts/machine-picker';
import { LOCAL_IMPORT_DEVICE } from '@renderer/features/session-import/import-source';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Sheet } from '@/components/ui/Sheet';
import { ModalClose } from '@/components/ui/ModalClose';
import { ModalSurfaceProvider } from '@renderer/lib/modal/modal-surface';
import { MarketDetailConfirmations } from '../extensions/panel/market-detail-dialog';
import { MarketAgentDetail } from '../extensions/panel/market-detail-agent';

const AgentSettingsDevice = observer(function AgentSettingsDevice({ onSelect }: { onSelect: (deviceId?: string) => void }) {
  const { translate } = useSessionMessages();
  const host = useLibraryHost();
  const machines = useInstalledMachines();
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border px-6 py-3 text-sm">
      <span>{translate('agentsPage.configureOn')}</span>
      <MachinePicker testId="agent-settings-device" machines={machines} selectedId={host.remote?.deviceId ?? LOCAL_IMPORT_DEVICE}
        onSelect={id => onSelect(id === LOCAL_IMPORT_DEVICE ? undefined : id)} />
    </div>
  );
});

export function AgentAppDetailDialog({ agentId, onClose, onCreate, onConfigureDevice, initialAdvanced = false }: {
  agentId: string;
  onClose: () => void;
  onCreate: () => void;
  onConfigureDevice?: (deviceId?: string) => void;
  initialAdvanced?: boolean;
}) {
  const titleId = useId();
  const [advancedOpen, setAdvancedOpen] = useState(initialAdvanced);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Sheet onClose={onClose} titleId={titleId} testId="market-detail-dialog" dimNested
      desktopWidth="min(704px, 100%)" desktopMaxHeight="calc(100dvh - 32px)"
      finalFocus={() => initialAdvanced
        ? document.querySelector<HTMLElement>(`[data-installed-id="${CSS.escape(agentId)}"]`) ?? false
        : opener.current?.isConnected ? opener.current : false}>
      <div className="relative flex min-h-0 flex-col">
        <ModalClose floating onClose={onClose} />
        <ModalSurfaceProvider>
          <MarketDetailConfirmations>
            <MarketAgentDetail agentId={agentId} titleId={titleId} onCreate={onCreate}
              advancedOpen={advancedOpen} onToggleAdvanced={() => setAdvancedOpen(open => !open)} />
            {onConfigureDevice && <AgentSettingsDevice onSelect={deviceId => {
              setAdvancedOpen(true);
              onConfigureDevice(deviceId);
            }} />}
          </MarketDetailConfirmations>
        </ModalSurfaceProvider>
      </div>
    </Sheet>
  );
}
