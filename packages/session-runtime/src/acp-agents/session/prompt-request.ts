import type { AcpSendPromptError, AcpTranscriptParser, NormalizedEvent, QueuedPrompt } from '@gugu/session-core/acp';
import { acpErr } from '@gugu/session-core/acp';
import { ok, type Result } from '@gugu/session-shared';
import type { SessionPromptResult } from './cell-deps';

export type PromptResult = Result<SessionPromptResult, AcpSendPromptError>;

/** Owned teardown, not a provider-authored failure. Retains the cancelled request's identity. */
export function cancelledPromptResult(sessionId: string, requestId?: string): PromptResult {
  return acpErr.promptFailed({ name: 'AcpPromptCancelled', code: 'CANCELLED', message: 'ACP session stopped',
    data: { reason: 'session-stop', sessionId, ...(requestId ? { requestId } : {}) } });
}

/** A dispatch is admitted independently of the foreground cycle that owns its native echo. */
export type PromptRequest = {
  messageId: string;
  prompt: QueuedPrompt;
  steered: boolean;
  cycle: Promise<PromptResult> | null;
  submitted: Extract<NormalizedEvent, { kind: 'message' }>;
  accepted: boolean;
  dispatched: boolean;
  completion: ReturnType<typeof Promise.withResolvers<PromptResult>>;
};

export function acceptPromptMessage(request: PromptRequest, messageId: string,
  push: (event: NormalizedEvent) => void, providerId: string,
  echo?: Extract<NormalizedEvent, { kind: 'message' }>): void {
  if (!echo) throw new Error(`ACP provider '${providerId}' returned an accepted receipt before its user echo (${messageId})`);
  request.accepted = true;
  push(echo);
}

export function settleAcceptedRequests(requests: Map<string, PromptRequest>, transcript: AcpTranscriptParser,
  cancelled?: (requestId: string) => PromptResult): void {
  for (const [id, request] of requests) {
    if (!request.accepted) continue;
    const owner = transcript.entityOwner({ ...request.submitted, messageId: request.messageId });
    const outcome = owner?.outcome;
    if (!outcome) continue;
    request.completion.resolve(outcome.kind === 'error'
      ? acpErr.promptFailed({ name: 'ForegroundError', message: outcome.detail ?? outcome.reason ?? 'Foreground failed' })
      : outcome.kind === 'cancelled' && cancelled ? cancelled(id) : ok({ queued: false }));
    requests.delete(id);
  }
}
