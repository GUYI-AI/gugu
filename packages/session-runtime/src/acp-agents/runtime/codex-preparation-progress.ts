import type { AcpStartProgress } from '@gugu/session-core/acp';
import { parseCodexPreparation } from '@gugu/core/local/codex-initialize.mjs';

export function noteCodexPreparation(provider: string, line: string, progress: Map<string, AcpStartProgress>, sessionId: string, publish: () => void): void {
  if (provider !== 'codex') return;
  const preparation = parseCodexPreparation(line);
  const previous = progress.get(sessionId);
  if (preparation === undefined || !previous) return;
  progress.set(sessionId, { ...previous, preparation: preparation ?? undefined });
  publish();
}
