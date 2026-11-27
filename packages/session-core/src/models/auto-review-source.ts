import type { CustomModelConnection } from './custom-model';
import {
  cliRefusesAutoMode, isAutoReviewCapable, isHaikuReviewModel, runsClaudeAutoMode,
  type AutoReviewModel, type PlatformReviewCandidate,
} from './auto-review-model';

export const DEFAULT_CLAUDE_REVIEWER = 'claude-haiku-5-5';

/** Who reviews: a model on the session's platform ticket, or a model on one of the user's connections. */
export type ClaudeReviewer =
  | { kind: 'platform'; modelId: string; label: string }
  | { kind: 'connection'; connectionId: string; modelId: string; label: string; byHaiku?: true;
    /** Not the session's own connection: the host diverts this one model's requests to it. */
    cross?: true };

/** Every reason Auto mode stays off. None of them falls back to another reviewer. */
export type ClaudeReviewUnavailable =
  | 'mainModelUnsupported' | 'noReviewer' | 'preferenceUnavailable'
  | 'platformReviewerNeedsPlatformSession' | 'reviewerExcluded' | 'crossReviewerUnroutable';

export type ClaudeReviewResolution = { ok: true; reviewer: ClaudeReviewer } | { ok: false; reason: ClaudeReviewUnavailable };

export type ReviewConnection = {
  id: string; name?: string; removed?: boolean; keySaved?: boolean;
  /** The connection's Anthropic Messages base URL; absent = it cannot serve Claude's classifier. */
  anthropicEndpoint?: string;
  models: readonly { id: string; label?: string }[];
};

/** The facts of a saved connection that decide whether it can serve a reviewer. */
export function reviewConnectionsOf(connections: readonly CustomModelConnection[]): ReviewConnection[] {
  return connections.map(connection => ({
    id: connection.id, name: connection.name, removed: connection.removed, keySaved: connection.keySaved,
    anthropicEndpoint: connection.endpoints.find(endpoint => endpoint.protocol === 'anthropic-messages')?.baseUrl,
    models: connection.models.map(model => ({ id: model.id, ...(model.label ? { label: model.label } : {}) })),
  }));
}

export type ClaudeReviewInput = {
  route: 'platform' | 'custom';
  /** The conversation model, without the `platform:` prefix. */
  mainModel: string | null | undefined;
  preference: AutoReviewModel;
  /** This account's catalog entries on the Anthropic wire (platform route, or to validate a platform preference). */
  platformModels: readonly PlatformReviewCandidate[];
  connections: readonly ReviewConnection[];
  /** The session's own connection (custom route). */
  session?: { connectionId: string; endpoint: string; models: readonly { id: string; label?: string }[]; removed?: boolean;
    /** The harness reaches this connection through a format converter, which no reviewer request can be diverted out of. */
    converted?: boolean };
};

const labelOf = (models: readonly { id: string; label?: string; displayName?: string }[], id: string) => {
  const entry = models.find(model => model.id === id);
  return (entry?.label ?? entry?.displayName)?.trim() || id;
};

function preferredReviewer(input: ClaudeReviewInput, preference: NonNullable<AutoReviewModel>): ClaudeReviewResolution {
  if (preference.kind === 'platform') {
    if (input.route !== 'platform') return { ok: false, reason: 'platformReviewerNeedsPlatformSession' };
    const model = input.platformModels.find(candidate => candidate.id === preference.modelId);
    return model && model.enabled !== false && !model.requiresMembership && isAutoReviewCapable(model.id)
      ? { ok: true, reviewer: { kind: 'platform', modelId: model.id, label: labelOf(input.platformModels, model.id) } }
      : { ok: false, reason: 'preferenceUnavailable' };
  }
  const connection = input.connections.find(candidate => candidate.id === preference.connectionId);
  if (!connection || connection.removed || !connection.keySaved || !connection.anthropicEndpoint
    || !connection.models.some(model => model.id === preference.modelId) || !isAutoReviewCapable(preference.modelId)) {
    return { ok: false, reason: 'preferenceUnavailable' };
  }
  const label = `${labelOf(connection.models, preference.modelId)}${connection.name ? ` (${connection.name})` : ''}`;
  // A converted session's requests leave through a format converter: no reviewer request can be told apart there.
  if (input.route === 'custom' && input.session?.converted) return { ok: false, reason: 'crossReviewerUnroutable' };
  if (input.route === 'custom' && input.session?.connectionId === preference.connectionId) {
    return { ok: true, reviewer: { kind: 'connection', connectionId: connection.id, modelId: preference.modelId, label } };
  }
  return { ok: true, reviewer: { kind: 'connection', connectionId: connection.id, modelId: preference.modelId, label, cross: true } };
}

/**
 * Resolve once from stored facts; a failed request is never an input. Order: the user's reviewer (any route
 * that can reach it) → the route's long-standing default. Nothing else: a session with no reviewer is off.
 */
export function resolveClaudeReviewer(input: ClaudeReviewInput): ClaudeReviewResolution {
  const main = input.mainModel?.trim();
  if (!main) return { ok: false, reason: 'noReviewer' };
  if (cliRefusesAutoMode(main)) return { ok: false, reason: 'mainModelUnsupported' };
  if (input.preference) return preferredReviewer(input, input.preference);
  if (input.route === 'platform') {
    // Platform Claude sessions have always been reviewed by the platform Haiku; other models need a pick.
    const haiku = input.platformModels.find(model => model.id === DEFAULT_CLAUDE_REVIEWER);
    return runsClaudeAutoMode(main) && haiku && haiku.enabled !== false && !haiku.requiresMembership
      ? { ok: true, reviewer: { kind: 'platform', modelId: DEFAULT_CLAUDE_REVIEWER, label: labelOf(input.platformModels, DEFAULT_CLAUDE_REVIEWER) } }
      : { ok: false, reason: 'noReviewer' };
  }
  const session = input.session;
  if (!session || session.removed || session.converted) return { ok: false, reason: 'noReviewer' };
  const own = (modelId: string, byHaiku?: true): ClaudeReviewResolution => ({ ok: true, reviewer: {
    kind: 'connection', connectionId: session.connectionId, modelId, label: labelOf(session.models, modelId), ...(byHaiku ? { byHaiku } : {}),
  } });
  if (new URL(session.endpoint).hostname === 'api.anthropic.com') return own(DEFAULT_CLAUDE_REVIEWER);
  if (isAutoReviewCapable(main)) return own(main);
  const haiku = session.models.find(model => model.id === DEFAULT_CLAUDE_REVIEWER)
    ?? session.models.find(model => isHaikuReviewModel(model.id));
  return haiku ? own(haiku.id, true) : { ok: false, reason: 'noReviewer' };
}

/** Native subscriptions retain the supplier's classifier. Only an official API key gets Haiku. */
export function nativeClaudeReviewEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  if (env.CLAUDE_CODE_OAUTH_TOKEN || (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN)) return {};
  const official = new URL(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').hostname === 'api.anthropic.com';
  if (official && env.ANTHROPIC_API_KEY) return { CLAUDE_CODE_AUTO_MODE_MODEL: DEFAULT_CLAUDE_REVIEWER, CLAUDE_CODE_AUTO_MODE_SERVER: '0' };
  const model = env.ANTHROPIC_MODEL?.trim();
  if (!official && model && isAutoReviewCapable(model) && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)) {
    return { CLAUDE_CODE_AUTO_MODE_MODEL: model, CLAUDE_CODE_AUTO_MODE_SERVER: '0' };
  }
  return {};
}
