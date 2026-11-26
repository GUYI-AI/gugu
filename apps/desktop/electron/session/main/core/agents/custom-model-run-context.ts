import type { ClaudeReviewResolution } from '@gugu/session-core/models/auto-review-source';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { antigravityCustomModelLaunch, claudeAcpPlatformSessionMeta, codexPlatformModelFacts, GUGU_PLATFORM_MODELS_ENV, OPENCODE_FAMILY_CONNECTION_PROVIDER_ID, pluginRegistry } from '@gugu/session-plugins/agents';
import { chatModel, customModelEfforts } from '@gugu/session-core/models/custom-model';
import { writeSessionSettingsFile } from '../../../../sessionpage/session-settings-file';
import { armReviewer, claudeReviewRunContext, resolveHostClaudeReviewer } from './claude-reviewer';
import { resolveCustomModel, type ResolvedCustomModel } from './custom-models';
import { CLAUDE_CONNECTION_UNSET_ENV, CODEX_CONNECTION_UNSET_ENV, claudeApiKeyEnv, codexApiKeyConnectionArgs } from './harness-connection-launch';

/** Who reviews this connection session: the user's pick on any connection that can be reached, else its own default. */
function reviewResolution(custom: ResolvedCustomModel): Promise<ClaudeReviewResolution> {
  return resolveHostClaudeReviewer({
    route: 'custom', mainModel: custom.models[0], platformModels: [],
    session: { connectionId: custom.connectionId, endpoint: custom.upstreamEndpoint, models: custom.entries,
      ...(custom.removed ? { removed: true } : {}), ...(custom.converted ? { converted: true } : {}) },
  });
}

function claudeModelEnv(custom: ResolvedCustomModel, reviewer: string | undefined): Record<string, string> {
  return {
    ...claudeApiKeyEnv(custom.apiKey, custom.endpoint, custom.models[0]),
    // No reviewer = Auto mode is off for this session (the menu says why); nothing else is named in its place.
    ...(reviewer ? { CLAUDE_CODE_AUTO_MODE_MODEL: reviewer, CLAUDE_CODE_AUTO_MODE_SERVER: '0' } : {}),
    ...(custom.capabilities?.contextWindow ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(custom.capabilities.contextWindow) } : {}),
  };
}

// Stable loopback credentials let both Claude surfaces reuse this protected file until the host exits.
const claudeSettingsFiles = new Map<string, Promise<string>>();

async function claudeModelSettings(custom: ResolvedCustomModel, reviewer: string | undefined): Promise<string> {
  const document = {
    apiKeyHelper: `echo ${custom.apiKey}`,
    env: { ...claudeModelEnv(custom, reviewer), ANTHROPIC_API_KEY: '' },
    // No reviewer: remove Auto mode, so the CLI's own mode switch cannot start it with a swapped-in reviewer.
    ...(reviewer ? {} : { permissions: { disableAutoMode: 'disable' } }),
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
  const reviewer = armReviewer(sessionId, await reviewResolution(custom));
  return claudeAcpPlatformSessionMeta({ settingsDocumentPath: await claudeModelSettings(custom, reviewer), env: {}, model: custom.models[0] });
}

/** The three native credential carriers retained by the custom-model contract. */
export async function resolveCustomModelRunContext(providerId: string, sessionId: string, sourceSessionId?: string, acp = false): Promise<Partial<AgentRunContext>> {
  const custom = await resolveCustomModel(providerId, sessionId, sourceSessionId);
  if (!custom) return {};
  const model = custom.models[0];
  const marker = { connectionId: custom.connectionId, customModel: { endpoint: custom.endpoint, ...(model ? { model } : {}) } };
  if (providerId === 'claude') {
    const resolution = await reviewResolution(custom);
    const reviewer = armReviewer(sessionId, resolution);
    return {
      ...marker,
      // No main model = the adapter's own default: the permission gate hides Auto mode before launch.
      ...(model?.trim() ? claudeReviewRunContext(resolution) : { autoReviewAllowed: false }),
      credentialEnv: claudeModelEnv(custom, reviewer),
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
    return { ...marker, credentialEnv: { OPENAI_API_KEY: custom.apiKey, ...catalog }, unsetEnv: [...CODEX_CONNECTION_UNSET_ENV], extraArgs: codexApiKeyConnectionArgs(custom.name, custom.endpoint, custom.upstreamEndpoint, model) };
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
