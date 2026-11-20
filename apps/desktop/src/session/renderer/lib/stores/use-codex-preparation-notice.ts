import { useEffect, useState } from 'react';
import type { CodexPreparation } from '@gugu/core/local/codex-initialize.mjs';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/** The menu reads the shared host probe; elapsed time never decides success or failure. */
export function useCodexPreparationNotice(preparation: CodexPreparation | undefined): string | undefined {
  const { translate } = useSessionMessages();
  const [now, setNow] = useState(Date.now());
  const startedAt = preparation?.startedAt;
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!preparation) return undefined;
  const seconds = Math.max(0, Math.floor((now - preparation.startedAt) / 1_000));
  const elapsed = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const label = translate(preparation.phase === 'history' ? 'transcript.historyPreparing' : 'transcript.preparing');
  return label + ' · ' + elapsed;
}
