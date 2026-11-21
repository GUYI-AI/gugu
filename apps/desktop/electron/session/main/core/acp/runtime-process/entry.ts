import { mergeDeliveryEnvelopes, recoverDeliveryEnvelopes } from '@gugu/core/local/agent/deliveryEnvelope';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { bootAcpRuntimeProcess } from '@gugu/session-runtime/acp-agents/node';
import { personalConversationPreview } from '@gugu/session-core/session-record/personal-conversation';
import { activityPreviewSources } from '@gugu/session-chat-ui/activity-preview';
// 回合期间攒下的多条投递信封合成一条 —— 实现体只有 core 这一份(spec delivery-routing 的单一属主),
// 这里只是把它接线进 ACP runtime。❌ session-runtime 不依赖 @gugu/core,也不复制信封语义。
bootAcpRuntimeProcess({
  pluginRegistry,
  projectConversationPreview: turn => personalConversationPreview(turn, activityPreviewSources),
  mergeEnvelopes: mergeDeliveryEnvelopes,
  recoverDelivery: recoverDeliveryEnvelopes,
});
