import { platform } from '@/platform';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { log } from '@renderer/utils/logger';
import { safeFailureLine } from './gugu-reason';

/**
 * #7334 the session id is not shown anywhere; whoever needs it takes it from a session menu (session/shared/session-menu.ts).
 * The **whole** id: a truncated one addresses nothing. A failure says why, sanitized, and is logged.
 */
export async function copySessionId(sessionId: string): Promise<void> {
  try {
    await platform.writeClipboardText(sessionId);
    toast({ title: translateSessionMessage('sidebar.sessionIdCopied') });
  } catch (error) {
    log.error({ error, sessionId }, 'copy session id failed');
    toast({ title: translateSessionMessage('task.copyFailed'), description: safeFailureLine(String((error as Error)?.message ?? error)), variant: 'destructive' });
  }
}
