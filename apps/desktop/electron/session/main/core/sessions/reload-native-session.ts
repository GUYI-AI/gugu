import { resolveSessionpageCredentialLifecycle } from '@gugu/session-plugins/agents';
import { lastStartedModelSource } from '@main/core/usage/model-source-recorder';
import type { SessionPlatformModel } from './platform-model-selection';

type BillingSource = 'platform' | 'own';

/**
 * What a model reload does to the native session: `none` = it stays on its billing route (or that cannot be told);
 * `preserve` / `replace` = it moves to the other route, and the engine resumes the same native session or needs a new one.
 *
 * The route the native session lives on is the one it last actually started on (`lastStartedModelSource`, written on
 * every start). ❌ Reading only the per-session choice: a session without one (an assistant created on its engine's own
 * model, its route coming from the agent) still started on a route — read as "unchanged", a codex assistant switched to
 * a Gugu model kept resuming its openai thread, and codex refused every start (modelProviderMismatch). Sessions started
 * before that ledger existed fall back to the per-session choice (the usage page's rule); neither = cannot tell.
 *
 * Same native session or a new one is the engine's answer for this leg (`sourceChangeSession`), resolved like every other
 * credential-lifecycle question: a session TUI riding on a native app-server answers by that app-server.
 */
export function reloadRouteChange(input: {
  sessionId: string;
  providerId: string;
  surface: 'acp' | 'tui';
  /** The per-session choice before the reload (`sessionPlatformModel`); undefined = none recorded. */
  platformBefore: SessionPlatformModel | null | undefined;
  target: BillingSource | null;
}): 'none' | 'preserve' | 'replace' {
  if (input.target === null) return 'none';
  const started = lastStartedModelSource(input.sessionId);
  const before: BillingSource | null = started
    ? started === 'gugu' ? 'platform' : 'own'
    : input.platformBefore === undefined ? null : input.platformBefore ? 'platform' : 'own';
  if (before === null || before === input.target) return 'none';
  return resolveSessionpageCredentialLifecycle(input.providerId, input.surface)?.sourceChangeSession ?? 'preserve';
}
