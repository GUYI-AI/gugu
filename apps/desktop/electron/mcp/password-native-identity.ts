import type { GuguMcpContext } from '../acp-engine-utils';

/** The same scope vocabulary used by the authenticated MCP grant descriptor. */
export function guguMcpToolScope(context: GuguMcpContext): string {
  return (context.kind !== 'social' ? 'session-only'
    : context.forkOf !== undefined ? (context.runSessionAction ? 'runtime-fork+session' : 'runtime-fork')
      : (context.runSessionAction ? 'gugu+session' : 'gugu')) + (context.personalAssistant ? ':assistant' : '');
}

/** Metadata only, not a live permission fact or approval. The native bridge stamps sessionId;
 * grantKey and request fields are never an identity source. Account/grant/installation/device
 * lifetime guards are still mandatory at the reader's actual construction point.
 */
export function passwordNativeMcpIdentity(context: GuguMcpContext) {
  const { expectedOwnerUserId: ownerId, subjectId, nativeSessionId: sessionId } = context;
  if (typeof sessionId !== 'string' || !sessionId.trim()
    || [ownerId, subjectId].some(value => typeof value !== 'string' || !value.trim())) return undefined;
  if (context.kind === 'social' && context.forkOf !== undefined) return undefined;
  return Object.freeze({ ownerId, subjectId, sessionId, toolScope: guguMcpToolScope(context) });
}
