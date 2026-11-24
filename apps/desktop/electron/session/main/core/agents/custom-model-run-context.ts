import { customClaudeReviewSource, type ClaudeReviewSource } from '@gugu/session-core/models/auto-review-source';
import { appSettingsService } from '@main/core/settings/settings-service';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { antigravityCustomModelLaunch, claudeAcpPlatformSessionMeta, codexPlatformModelFacts, GUGU_PLATFORM_MODELS_ENV, OPENCODE_FAMILY_CONNECTION_PROVIDER_ID, pluginRegistry } from '@gugu/session-plugins/agents';
import { chatModel, customModelEfforts } from '@gugu/session-core/models/custom-model';
import { writeSessionSettingsFile } from '../../../../sessionpage/session-settings-file';
import { resolveCustomModel, type ResolvedCustomModel } from './custom-models';
import { CLAUDE_CONNECTION_UNSET_ENV, CODEX_CONNECTION_UNSET_ENV, claudeApiKeyEnv, codexApiKeyConnectionArgs } from './harness-connection-launch';

async function reviewSource(custom: ResolvedCustomModel): Promise<ClaudeReviewSource> {
  return customClaudeReviewSource({
    connectionId: custom.connectionId, endpoint: custom.upstreamEndpoint,
    selectedModel: custom.models[0], models: custom.entries, removed: custom.removed,
    preference: await appSettingsService.get('autoReviewModel'),
  });
}

async function claudeModelEnv(custom: ResolvedCustomModel, selected?: ClaudeReviewSource): Promise<Record<string, string>> {
  const reviewer = selected ?? await reviewSource(custom);
  return {
    ...claudeApiKeyEnv(custom.apiKey, custom.endpoint, custom.models[0]),
    // The cross-connection fallback is reserved, not connected in the first release.
    // With no explicit main model the permission gate hides Auto mode before launch.
    ...(reviewer.kind === 'own' ? { CLAUDE_CODE_AUTO_MODE_MODEL: reviewer.modelId, CLAUDE_CODE_AUTO_MODE_SERVER: '0' } : {}),
    ...(custom.capabilities?.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(custom.capabilities.contextWindow) } : {}),
  };
}

// Stable loopback credentials let both Claude surfaces reuse this protected file until the host exits.
const claudeSettingsFiles = new Map<string, Promise<string>>();

async function claudeModelSettings(custom: ResolvedCustomModel, selected?: ClaudeReviewSource): Promise<string> {
  const document = {
    apiKeyHelper: `echo ${custom.apiKey}`,
    env: { ...await claudeModelEnv(custom, selected), ANTHROPIC_API_KEY: '' },
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
    const reviewer = await reviewSource(custom);
    return {
      ...marker,
      autoReviewAllowed: Boolean(model?.trim()) && reviewer.kind === 'own',
      ...(model?.trim() && reviewer.kind !== 'own' ? { autoReviewUnavailable: true } : {}),
      ...(reviewer.kind === 'own' && reviewer.byHaiku ? { autoReviewByHaiku: true } : {}),
      credentialEnv: await claudeModelEnv(custom, reviewer),
      ...(acp ? {} : { extraArgs: ['--settings', await claudeModelSettings(custom, reviewer)] }),
      unsetEnv: [...CLAUDE_CONNECTION_UNSET_ENV, 'ANTHROPIC_MODEL'],
    };
  }
  if (providerId === 'codex') {
    // Codex runs a model it does not know on a fallback with no levels. The facts a platform model hands it
    // (its window and levels, rendered into Codex's model catalog) carry this connection's models the same way.
    const facts = (entry: ResolvedCustomModel['entries'][number]) => ({
      id: entry.id, displayName: entry.label || entry.id, contextWindow: entry.contextWindow ?? null,
      reasoningEfforts: customModelEfforts(entry, pluginRegistry.get('codex')?.capabilities.effort),
    });
    const selected = custom.entries.find(({ id }) => id === model);
    const catalog: Record<string, string> = model && selected ? { [GUGU_PLATFORM_MODELS_ENV]: codexPlatformModelFacts({ model, contextWindow: selected.contextWindow, reasoningEfforts: facts(selected).reasoningEfforts, models: custom.entries.filter(chatModel).map(facts) }) } : {};
    return { ...marker, credentialEnv: { OPENAI_API_KEY: custom.apiKey, ...catalog }, unsetEnv: [...CODEX_CONNECTION_UNSET_ENV], extraArgs: codexApiKeyConnectionArgs(custom.name, custom.endpoint, model) };
  }
  if (providerId === 'opencode' && acp && model) {
    return {
      ...marker,
      customModel: { ...marker.customModel, runtimeOption: `${OPENCODE_FAMILY_CONNECTION_PROVIDER_ID}/${model}` },
    };
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
