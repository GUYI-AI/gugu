import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpAgentApi, AcpClientFactory, AcpProcessIo } from '@gugu/session-core/agents/plugins';
import { flattenSelectOptions } from '@gugu/session-core/acp';
import { connectStdioAcpV2 } from '../../helpers/acp-v2';
import { createClaudeSessionDecoder } from './acp-transform';
import { claudeReviewConfig, claudeAutoReviewAvailable } from './auto-review';

/** A connection is pinned to the actual executable selected at launch, including after reconnect. */
export function connectClaudeWithReview(io: AcpProcessIo, toClient: AcpClientFactory, version?: string): AcpAgentApi {
  const denied = new Map<string, Set<string>>();
  const configs = new Map<string, readonly SessionConfigOption[]>();
  const filter = (id: string, options: readonly SessionConfigOption[]) => {
    const filtered = claudeReviewConfig(options, version);
    configs.set(id, filtered);
    return filtered;
  };
  const api = connectStdioAcpV2(io, agent => {
    const client = toClient(agent);
    return { ...client, sessionEvent(params) {
      const event = params.event;
      if (event.kind === 'tool_update' && event.status === 'failed') {
        // The pinned bridge's v2 renderer puts the reason in content, and may omit
        // decisionReason/message from metadata. Read the decoded event, never diagnostic trace.
        const claude = event._meta?.claudeCode as { toolName?: string; toolResponse?: {
          decisionReason?: string; decisionReasonType?: string; message?: string;
        } } | undefined;
        const response = claude?.toolResponse;
        const contentReason = event.outputText?.match(/^Permission denied:\s*([\s\S]+)$/)?.[1];
        const reason = response && (response.decisionReason ?? contentReason
          ?? (response.decisionReasonType ? response.message : undefined));
        let sessionDenied = denied.get(params.sessionId);
        if (reason && !sessionDenied?.has(event.toolCallId)) {
          if (!sessionDenied) denied.set(params.sessionId, sessionDenied = new Set());
          sessionDenied.add(event.toolCallId);
          const line = `${event.toolName ?? claude?.toolName ?? 'Action'}: ${reason}`.replace(/\s+/g, ' ');
          client.sessionEvent({ sessionId: params.sessionId, event: { kind: 'session_notice', code: 'provider-notice', title: line, detail: line } });
        }
      }
      client.sessionEvent(params.event.kind === 'config'
        ? { ...params, event: { ...params.event, options: filter(params.sessionId, params.event.options) } }
        : params);
    } };
  }, createClaudeSessionDecoder());
  const assertAuto = (id: string) => {
    const mode = configs.get(id)?.find(option => option.category === 'mode' && option.type === 'select');
    if (mode?.type !== 'select' || !flattenSelectOptions(mode.options).some(option => option.value === 'auto')) {
      throw new Error('AI review is unavailable for this session executable and model');
    }
  };
  return {
    ...api,
    async newSession(params) {
      const result = await api.newSession(params);
      return { ...result, ...(result.configOptions ? { configOptions: filter(result.sessionId, result.configOptions) } : {}) };
    },
    async loadSession(params) {
      const result = await api.loadSession!(params);
      return { ...result, ...(result.configOptions ? { configOptions: filter(params.sessionId, result.configOptions) } : {}) };
    },
    async setSessionConfigOption(params) {
      if (params.value === 'auto') assertAuto(params.sessionId);
      const current = configs.get(params.sessionId);
      const mode = current?.find(option => option.category === 'mode' && option.type === 'select');
      const model = current?.find(option => option.category === 'model');
      if (params.configId === model?.id && mode?.type === 'select' && mode.currentValue === 'auto'
        && !claudeAutoReviewAvailable(version, typeof params.value === 'string' ? params.value : undefined)) {
        throw new Error('Change permissions before selecting a model without AI review support');
      }
      const result = await api.setSessionConfigOption!(params);
      return { ...result, ...(result.configOptions ? { configOptions: filter(params.sessionId, result.configOptions) } : {}) };
    },
    async setSessionMode(params) {
      if (params.modeId === 'auto') assertAuto(params.sessionId);
      return api.setSessionMode!(params);
    },
  };
}
