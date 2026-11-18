import type { AutoReviewModel } from './auto-review-model';

export const DEFAULT_CLAUDE_REVIEWER = 'claude-haiku-5-5';
export type ClaudeReviewSource = { kind: 'own'; modelId: string } | { kind: 'platform-fallback' };

/** Resolve once from connection facts. A failed request is never an input to routing. */
export function customClaudeReviewSource(input: {
  connectionId: string; endpoint: string; selectedModel?: string;
  models: readonly { id: string }[]; removed?: boolean; preference: AutoReviewModel;
}): ClaudeReviewSource {
  const preferred = input.preference;
  if (!input.removed && preferred?.connectionId === input.connectionId
    && input.models.some(model => model.id === preferred.modelId)) {
    return { kind: 'own', modelId: preferred.modelId };
  }
  if (new URL(input.endpoint).hostname === 'api.anthropic.com') {
    return { kind: 'own', modelId: DEFAULT_CLAUDE_REVIEWER };
  }
  const modelId = input.selectedModel?.trim();
  return modelId ? { kind: 'own', modelId } : { kind: 'platform-fallback' };
}

/** Native subscriptions retain the supplier's classifier. Only an official API key gets Haiku. */
export function nativeClaudeReviewEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return {};
  const official = new URL(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').hostname === 'api.anthropic.com';
  if (official && env.ANTHROPIC_API_KEY) return { CLAUDE_CODE_AUTO_MODE_MODEL: DEFAULT_CLAUDE_REVIEWER };
  const model = env.ANTHROPIC_MODEL?.trim();
  if (!official && model && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) {
    return { CLAUDE_CODE_AUTO_MODE_MODEL: model };
  }
  return {};
}
