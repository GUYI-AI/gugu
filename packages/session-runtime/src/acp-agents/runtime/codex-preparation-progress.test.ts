import { describe, it, expect, vi } from 'vitest';
import type { AcpStartProgress } from '@gugu/session-core/acp';
import { CODEX_PREPARATION_PREFIX } from '@gugu/core/local/codex-initialize.mjs';
import { noteCodexPreparation } from './codex-preparation-progress';

describe('native preparation facts in the shared session summary', () => {
  it('publishes phase and elapsed-time origin, then clears only preparation on readiness', () => {
    const original: AcpStartProgress = { stage: 'opening-session', since: 1, startedAt: 1, executable: 'codex' };
    const progress = new Map([['s', original]]);
    const publish = vi.fn();
    const fact = { phase: 'history', startedAt: 10, attempt: 2 };
    noteCodexPreparation('codex', CODEX_PREPARATION_PREFIX + JSON.stringify(fact), progress, 's', publish);
    expect(progress.get('s')).toEqual({ ...original, preparation: fact });
    noteCodexPreparation('codex', CODEX_PREPARATION_PREFIX + 'null', progress, 's', publish);
    expect(progress.get('s')).toEqual({ ...original, preparation: undefined });
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it('does not manufacture progress for another provider or a settled start', () => {
    const progress = new Map<string, AcpStartProgress>(); const publish = vi.fn();
    const line = CODEX_PREPARATION_PREFIX + JSON.stringify({ phase: 'preparing', startedAt: 1, attempt: 1 });
    noteCodexPreparation('claude', line, progress, 's', publish);
    noteCodexPreparation('codex', line, progress, 's', publish);
    expect(progress.size).toBe(0); expect(publish).not.toHaveBeenCalled();
  });
});
