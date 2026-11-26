import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import {
  resolveClaudeReviewer, reviewConnectionsOf, reviewerHonouredByAllowlist,
  type ClaudeReviewer, type ClaudeReviewInput, type ClaudeReviewResolution, type ClaudeReviewUnavailable,
} from '@gugu/session-core/models/auto-review-source';
import type { AutoReviewModel, PlatformReviewCandidate } from '@gugu/session-core/models/auto-review-model';
import { log } from '@main/lib/logger';
import { forgetReviewRoute, reviewRouteAlias } from './review-routes';

export type UserModelAllowlist = { file: string; pointer: string; models: string[] };

/**
 * The model allowlist a plugin declares in the user's own agent home (Claude: `~/.claude/settings.json`
 * `availableModels`). Null when there is none; a file that exists but cannot be read throws.
 */
export async function readUserModelAllowlist(env: NodeJS.ProcessEnv, providerId: string): Promise<UserModelAllowlist | null> {
  const models = pluginRegistry.get(providerId)?.capabilities.models;
  const allowlist = models?.kind === 'selectable' ? models.userAllowlist : undefined;
  if (!allowlist) return null;
  const configuredRoot = allowlist.envVar ? env[allowlist.envVar]?.trim() : undefined;
  const file = configuredRoot
    ? join(configuredRoot, allowlist.file.split('/').at(-1)!)
    : join(env.HOME?.trim() || homedir(), allowlist.file);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`无法读取用户设置 ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let current: unknown = document;
  for (const segment of allowlist.pointer.slice(1).split('/')) {
    current = current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined;
  }
  if (!Array.isArray(current)) return null;
  return {
    file: allowlist.file,
    pointer: allowlist.pointer.slice(1).split('/').filter(Boolean).join('.'),
    models: current.filter((entry): entry is string => typeof entry === 'string').map(entry => entry.trim()),
  };
}

export type HostClaudeReviewInput = Omit<ClaudeReviewInput, 'preference' | 'connections'> & {
  env?: NodeJS.ProcessEnv;
  /** Already-listed connections, to skip a second read. */
  connections?: readonly CustomModelConnection[];
  /** The name the CLI is given for this reviewer (a platform model's gateway alias); the allowlist is matched on it. */
  cliModelName?: (reviewer: ClaudeReviewer) => string;
};

async function storedPreference(): Promise<{ ok: true; value: AutoReviewModel } | { ok: false }> {
  try {
    const { appSettingsService } = await import('@main/core/settings/settings-service');
    return { ok: true, value: await appSettingsService.get('autoReviewModel') };
  } catch (error) {
    log.warn('[auto-review] the review model setting could not be read', { error: String(error) });
    return { ok: false };
  }
}

/** Only a connection pick needs the user's connections, and only that one (a launch never runs the discovery scan). */
async function preferredConnection(connectionId: string): Promise<CustomModelConnection[]> {
  try {
    const record = await (await import('./custom-models')).storedCustomModel(connectionId);
    return record ? [record] : [];
  } catch (error) {
    log.warn('[auto-review] the review model connection could not be read', { connectionId, error: String(error) });
    return [];
  }
}

/**
 * The host's one reviewer resolution for a gateway Claude session (platform or custom connection): the stored
 * preference, the user's connections and this account's catalog. A reviewer the user's own allowlist would make
 * Claude Code ignore is reported, never launched: the CLI would review with the main model instead.
 */
export async function resolveHostClaudeReviewer(input: HostClaudeReviewInput): Promise<ClaudeReviewResolution> {
  const preference = await storedPreference();
  // A pick that cannot be read is not "no pick": nothing else reviews in its place.
  if (!preference.ok) return { ok: false, reason: 'preferenceUnavailable' };
  const picked = preference.value;
  const connections = picked?.kind === 'custom' ? input.connections ?? await preferredConnection(picked.connectionId) : [];
  const resolution = resolveClaudeReviewer({
    route: input.route, mainModel: input.mainModel, platformModels: input.platformModels, session: input.session,
    preference: picked, connections: reviewConnectionsOf(connections),
  });
  if (!resolution.ok) return resolution;
  const allowlist = await readUserModelAllowlist(input.env ?? process.env, 'claude').catch(() => null);
  const reviewer = resolution.reviewer;
  // A diverted reviewer is named by a per-session alias, which no hand-written allowlist lists.
  const honoured = reviewer.kind === 'connection' && reviewer.cross
    ? !allowlist
    : reviewerHonouredByAllowlist(input.cliModelName?.(reviewer) ?? reviewer.modelId, allowlist?.models ?? null);
  return honoured ? resolution : { ok: false, reason: 'reviewerExcluded' };
}

/** Message keys (taskConfig.*) for each reason Auto mode stays off; the renderer and the phone translate them. */
export const CLAUDE_REVIEW_REASON_KEYS: Record<ClaudeReviewUnavailable, string> = {
  mainModelUnsupported: 'taskConfig.reviewMainModelUnsupported',
  noReviewer: 'taskConfig.reviewNoReviewer',
  preferenceUnavailable: 'taskConfig.reviewPreferenceUnavailable',
  platformReviewerNeedsPlatformSession: 'taskConfig.reviewPlatformReviewerNeedsPlatformSession',
  reviewerExcluded: 'taskConfig.reviewReviewerExcluded',
  crossReviewerUnroutable: 'taskConfig.reviewCrossReviewerUnroutable',
};

/** The run-context half of a resolution: what the ACP menu filter and the terminal launch check read. */
export function claudeReviewRunContext(resolution: ClaudeReviewResolution): Pick<AgentRunContext,
  'autoReviewAllowed' | 'autoReviewUnavailable' | 'autoReviewByHaiku' | 'autoReviewer' | 'autoReviewReason'> {
  if (!resolution.ok) {
    return { autoReviewAllowed: false, autoReviewUnavailable: true, autoReviewReason: CLAUDE_REVIEW_REASON_KEYS[resolution.reason] };
  }
  const reviewer = resolution.reviewer;
  return {
    autoReviewAllowed: true,
    ...(reviewer.kind === 'connection' && reviewer.byHaiku ? { autoReviewByHaiku: true } : {}),
    autoReviewer: { label: reviewer.label, kind: reviewer.kind },
  };
}

/** The run-context fields one reviewer resolution sets. */
export type ClaudeReviewRunContext = ReturnType<typeof claudeReviewRunContext>;

/** The catalog offered a reviewer the session's ticket does not carry: picking it again in Settings would not help. */
export const REVIEWER_NOT_ON_TICKET_KEY = 'taskConfig.reviewReviewerNotOnTicket';

const REVIEW_FIELDS = ['autoReviewAllowed', 'autoReviewUnavailable', 'autoReviewByHaiku', 'autoReviewer', 'autoReviewReason'] as const;

/**
 * A Gugu-model session's menu verdict once its ticket is issued. The launch resolved the reviewer from the ticket's
 * switchable models, the ones the CLI can actually call, and wrote that reviewer or `disableAutoMode` into the
 * session's settings. The run context resolved it from the account catalog, which can list a model the ticket lacks
 * (an old edge function sends no switchable models at all). The menu says what the CLI runs.
 */
export function withLaunchedReview<C extends Partial<AgentRunContext>>(context: C, launched: ClaudeReviewRunContext): C {
  const next: Partial<AgentRunContext> = { ...context };
  for (const field of REVIEW_FIELDS) delete next[field];
  const notOnTicket = context.autoReviewAllowed === true && launched.autoReviewAllowed === false
    && (launched.autoReviewReason === CLAUDE_REVIEW_REASON_KEYS.noReviewer
      || launched.autoReviewReason === CLAUDE_REVIEW_REASON_KEYS.preferenceUnavailable);
  return { ...next, ...launched, ...(notOnTicket ? { autoReviewReason: REVIEWER_NOT_ON_TICKET_KEY } : {}) } as C;
}

/** Register (or clear) the session's diverted reviewer for this resolution; returns the id to put in the settings. */
export function armReviewer(sessionId: string, resolution: ClaudeReviewResolution): string | undefined {
  forgetReviewRoute(sessionId);
  if (!resolution.ok) return undefined;
  const reviewer = resolution.reviewer;
  return reviewer.kind === 'connection' && reviewer.cross
    ? reviewRouteAlias(sessionId, { connectionId: reviewer.connectionId, modelId: reviewer.modelId })
    : reviewer.modelId;
}

/** A platform catalog row as the review rule reads it (the menu's `platform:` prefix removed). */
export function platformReviewCandidates(models: readonly { id: string; name?: string; displayName?: string; source?: string;
  requires_membership?: true; requiresMembership?: boolean }[]): PlatformReviewCandidate[] {
  return models.filter(model => model.source === undefined || model.source === 'gugu').map(model => ({
    id: model.id.replace(/^platform:/, ''),
    displayName: model.displayName ?? model.name,
    requiresMembership: model.requiresMembership === true || model.requires_membership === true,
  }));
}

/** A platform Claude session's reviewer, from this account's catalog (the run context; the launch resolves the same facts). */
export async function platformClaudeReviewContext(mainModel: string, transport: 'acp' | 'pty', env?: NodeJS.ProcessEnv) {
  const { listLocalPlatformModels } = await import('./session-discovery');
  const catalog = await listLocalPlatformModels('claude', transport).catch(() => null);
  return claudeReviewRunContext(await resolveHostClaudeReviewer({
    route: 'platform', mainModel, platformModels: platformReviewCandidates(catalog?.models ?? []), env,
  }));
}
