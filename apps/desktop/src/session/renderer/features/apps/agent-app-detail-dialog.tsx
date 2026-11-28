import { useId, useRef } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ModalClose } from '@/components/ui/ModalClose';
import { ModalSurfaceProvider } from '@renderer/lib/modal/modal-surface';
import { MarketDetailConfirmations } from '../extensions/panel/market-detail-dialog';
import { MarketAgentDetail } from '../extensions/panel/market-detail-agent';

export function AgentAppDetailDialog({ agentId, onClose, onCreate }: {
  agentId: string;
  onClose: () => void;
  onCreate: () => void;
}) {
  const titleId = useId();
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return (
    <Sheet onClose={onClose} titleId={titleId} testId="market-detail-dialog" dimNested
      desktopWidth="min(704px, 100%)" desktopMaxHeight="calc(100dvh - 32px)"
      finalFocus={() => opener.current?.isConnected ? opener.current : false}>
      <div className="relative flex min-h-0 flex-col">
        <ModalClose floating onClose={onClose} />
        <ModalSurfaceProvider>
          <MarketDetailConfirmations>
            <MarketAgentDetail agentId={agentId} titleId={titleId} onCreate={onCreate} />
          </MarketDetailConfirmations>
        </ModalSurfaceProvider>
      </div>
    </Sheet>
  );
}
