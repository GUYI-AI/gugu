import { useEffect, useState } from 'react';
import type { AcpStartProgress } from '@gugu/session-core/acp';
import { watchRunningSession, type RunningSessionWatch } from '@renderer/lib/acp/running-sessions';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';

export function CodexPreparationStatus({ sessionId }: { sessionId: string }) {
  const { translate } = useSessionMessages();
  const [preparation, setPreparation] = useState<AcpStartProgress['preparation']>();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let disposed = false;
    let watch: RunningSessionWatch | null = null;
    const changed = () => { if (!disposed && watch) setPreparation(watch.preparation?.()); };
    void watchRunningSession(sessionId, { onChange: changed, onGone: () => { if (!disposed) setPreparation(undefined); } }).then(value => {
      if (disposed) { value.dispose(); return; }
      watch = value; changed();
    }, error => log.warn('Codex preparation status unavailable', { sessionId, error }));
    return () => { disposed = true; watch?.dispose(); };
  }, [sessionId]);
  useEffect(() => {
    if (preparation?.startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [preparation?.startedAt]);
  const seconds = preparation ? Math.max(0, Math.floor((now - preparation.startedAt) / 1_000)) : 0;
  // A start that is over within its first second gets no band: drawn, it pushes the transcript up and back for a few frames.
  if (!preparation || seconds < 1) return null;
  const elapsed = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const label = translate(preparation.phase === 'history' ? 'transcript.historyPreparing' : 'transcript.preparing');
  return <div role="status" aria-label={label} aria-live="polite" data-codex-preparing={preparation.phase} className="flex items-center gap-2 px-3 py-1 text-[length:var(--font-caption)] opacity-60">
    <span>{label}</span><span aria-hidden="true">{elapsed}</span>
  </div>;
}
