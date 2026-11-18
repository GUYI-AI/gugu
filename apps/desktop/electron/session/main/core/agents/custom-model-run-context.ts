import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { antigravityCustomModelLaunch, claudeAcpPlatformSessionMeta } from '@gugu/session-plugins/agents';
import { writeSessionSettingsFile } from '../../../../sessionpage/session-settings-file';
import { resolveCustomModel, type ResolvedCustomModel } from './custom-models';
import { CLAUDE_CONNECTION_UNSET_ENV, CODEX_CONNECTION_UNSET_ENV, claudeApiKeyEnv, codexApiKeyConnectionArgs } from './harness-connection-launch';

function claudeModelEnv(custom: ResolvedCustomModel): Record<string, string> {
  return {
    ...claudeApiKeyEnv(custom.apiKey, custom.endpoint, custom.models[0]),
    ...(custom.capabilities?.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(custom.capabilities.contextWindow) } : {}),
  };
}

// Stable loopback credentials let both Claude surfaces reuse this protected file until the host exits.
const claudeSettingsFiles = new Map<string, Promise<string>>();

function claudeModelSettings(custom: ResolvedCustomModel): Promise<string> {
  const document = {
    apiKeyHelper: `echo ${custom.apiKey}`,
    env: { ...claudeModelEnv(custom), ANTHROPIC_API_KEY: '' },
  };
  const key = JSON.stringify(document);
  const existing = claudeSettingsFiles.get(key);
  if (existing) return existing;
  const write = writeSessionSettingsFile(document).catch((error: unknown) => {
    claudeSettingsFiles.delete(key);
    throw error;
  });
  claudeSettingsFiles.set(key, write);
  return write;
}

export async function claudeCustomModelSessionMeta(sessionId: string, sourceSessionId?: string) {
  const custom = await resolveCustomModel('claude', sessionId, sourceSessionId);
  if (!custom) return null;
  return claudeAcpPlatformSessionMeta({ settingsDocumentPath: await claudeModelSettings(custom), env: {}, model: custom.models[0] });
}

/** The three native credential carriers retained by the custom-model contract. */
export async function resolveCustomModelRunContext(providerId: string, sessionId: string, sourceSessionId?: string, acp = false): Promise<Partial<AgentRunContext>> {
  const custom = await resolveCustomModel(providerId, sessionId, sourceSessionId);
  if (!custom) return {};
  const model = custom.models[0];
  const marker = { connectionId: custom.connectionId, customModel: { endpoint: custom.endpoint, ...(model ? { model } : {}) } };
  if (providerId === 'claude') {
    return {
      ...marker,
      credentialEnv: claudeModelEnv(custom),
      ...(acp ? {} : { extraArgs: ['--settings', await claudeModelSettings(custom)] }),
      unsetEnv: [...CLAUDE_CONNECTION_UNSET_ENV, 'ANTHROPIC_MODEL'],
    };
  }
  if (providerId === 'codex') {
    return { ...marker, credentialEnv: { OPENAI_API_KEY: custom.apiKey }, unsetEnv: [...CODEX_CONNECTION_UNSET_ENV], extraArgs: codexApiKeyConnectionArgs(custom.name, custom.endpoint, model) };
  }
  if (providerId === 'antigravity') {
    const launch = antigravityCustomModelLaunch({ apiKey: custom.apiKey, endpoint: custom.endpoint, model });
    return { ...marker, credentialEnv: launch.env, unsetEnv: [...launch.unsetEnv] };
  }
  if (providerId === 'dsh' && !model) {
    return { ...marker, credentialEnv: { DEEPSEEK_API_KEY: custom.apiKey, DEEPSEEK_BASE_URL: custom.endpoint }, unsetEnv: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'] };
  }
  return marker;
}
