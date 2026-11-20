import { MarketAgentDetail } from '../extensions/panel/market-detail-agent';
import { MarketDetailDialog } from '../extensions/panel/market-detail-dialog';

/** Agent links and the installed list use the same approved details dialog as the marketplace. */
export function AgentAppDetailDialog({ agentId, onClose, onCreate }: {
  agentId: string;
  onClose: () => void;
  onCreate: () => void;
}) {
  return <MarketDetailDialog onClose={onClose}>
    <MarketAgentDetail agentId={agentId} onCreate={onCreate} />
  </MarketDetailDialog>;
}
