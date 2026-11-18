import { canSpecifyClaudeReviewModel, isHaikuReviewModel, type AutoReviewModel } from './auto-review-model';

export const DEFAULT_CLAUDE_REVIEWER = 'claude-haiku-5-5';
export type ClaudeReviewSource = { kind: 'own'; modelId: string; byHaiku?: true } | { kind: 'platform-fallback' };

/** Resolve once from connection facts. A failed request is never an input to routing. */
export function customClaudeReviewSource(input: {
  connectionId: string; endpoint: string; selectedModel?: string;
  models: readonly { id: string }[]; removed?: boolean; preference: AutoReviewModel;
}): ClaudeReviewSource {
  const preferred = input.preference;
  if (!input.removed && preferred?.connectionId === input.connectionId
    && canSpecifyClaudeReviewModel(preferred.modelId) && input.models.some(model => model.id === preferred.modelId)) {
    return { kind: 'own', modelId: preferred.modelId };
  }
  if (new URL(input.endpoint).hostname === 'api.anthropic.com') {
    return { kind: 'own', modelId: DEFAULT_CLAUDE_REVIEWER };
  }
  const modelId = input.selectedModel?.trim();
  if (modelId && canSpecifyClaudeReviewModel(modelId)) return { kind: 'own', modelId };
  const haiku = input.models.find(model => model.id === DEFAULT_CLAUDE_REVIEWER)
    ?? input.models.find(model => isHaikuReviewModel(model.id));
  return haiku ? { kind: 'own', modelId: haiku.id, byHaiku: true } : { kind: 'platform-fallback' };
}

/** Native subscriptions retain the supplier's classifier. Only an official API key gets Haiku. */
export function nativeClaudeReviewEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN || (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN)) return {};
  const official = new URL(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').hostname === 'api.anthropic.com';
  if (official && env.ANTHROPIC_API_KEY) return { CLAUDE_CODE_AUTO_MODE_MODEL: DEFAULT_CLAUDE_REVIEWER, CLAUDE_CODE_AUTO_MODE_SERVER: '0' };
  const model = env.ANTHROPIC_MODEL?.trim();
  if (!official && model && canSpecifyClaudeReviewModel(model) && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) {
    return { CLAUDE_CODE_AUTO_MODE_MODEL: model, CLAUDE_CODE_AUTO_MODE_SERVER: '0' };
  }
  return {};
}
