import { useLibraryHost } from '@renderer/features/library/library-host';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { AgentConnectionDetails } from './AgentConnectionDetails';
import { agentOffersConnections } from './agent-account';

/**
 * 详情里的「连接」一节(#2507)。
 *
 * 每一家都是同一种样子:当前连接 + 添加连接,方式按这一家支持的给(账号登录 / API Key),
 * 与设置「订阅」页那一行是同一块(`AgentConnectionDetails`)。owner 2026-11-12:「你非得每个都不一样干嘛」——
 * ❌ Claude 一种、OpenCode 一行「账号 · 登录」、Pi 一片空白。
 *
 * 两种方式都没有的家(在咕咕里登不上、也接不了 Key)不画这一节:❌ 摆一颗点了登不上的按钮。
 *
 * ⚠️ 这一格是**内容**:容器形态(右侧抽屉 / 居中模态)由 #6088 定,❌ 别在这里动容器。
 */
export function AgentAccountSection({ agent }: { agent: AgentPayload }) {
  const host = useLibraryHost();
  if (!agentOffersConnections(agent)) return null;
  return <AgentConnectionDetails agent={agent} machine={host.remote?.deviceId ?? null} />;
}
