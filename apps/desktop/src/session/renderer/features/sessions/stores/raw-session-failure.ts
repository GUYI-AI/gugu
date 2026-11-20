import { codexStartupKind } from '@gugu/core/local/codex-startup-failure.mjs';
import type { SessionFailure } from './session-failure';

/** Preserve the diagnostic and the host's reason code before a creation error becomes domain state. */
export function rawSessionFailure(error: unknown): Extract<SessionFailure, { kind: 'raw' }> {
  const startupReason = codexStartupKind(error);
  return {
    kind: 'raw', detail: error instanceof Error ? error.message : String(error),
    ...(startupReason ? { startupReason } : {}),
  };
}
