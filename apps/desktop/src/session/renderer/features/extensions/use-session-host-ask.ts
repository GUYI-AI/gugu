import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComposerPermissionRequest } from '@gugu/session-ui/react/components';
import type { AskSource, RecordCursor, Settlement, SessionpageSessionEvent, TimelineAfterResult } from '@gugu/session-core/session-record/contract';
import { sessionpageSessionTimelineChannel } from '@shared/core/session-timeline/sessionTimelineEvents';
import { appInstallAskOf } from '@shared/extensions/host-actions';
import { deviceCapabilityAskOf } from '@shared/device-capability-ask';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { answerAppInstall, answeredTooLate, appInstallWords, sessionWaitsOnApproval } from './app-install-approval';
import { deviceCapabilityWords } from './device-capability-approval';
import { latestAgentQuestion } from '@/lib/agentQuestion';
import { batchDiscontinuity, mergeSettlements } from '@/components/session-watch/agent-watch-store';

const pendingHostAsk = (settlements: Readonly<Record<string, Settlement>>, sources: readonly AskSource[]): Settlement | null =>
  Object.values(settlements).find((settlement) => settlement.origin && sources.includes(settlement.origin.source) && settlement.state === 'pending') ?? null;
/** The host's approvals the band answers (an agent's question has its own card). */
const HOST_APPROVALS: readonly AskSource[] = ['app-install', 'device-capability'];

/**
 * D-31 (L11 复核 67) The ask the host keeps pending on this session's timeline — an App install it asks for the agent — for
 * the session page's band, here or for a session another desktop runs (the timeline is read on that machine). A chat-UI
 * session's own approvals stay where they are (the runtime's queue); the host's are the timeline's, for either kind.
 */
export function useSessionHostAsk(
  sessionId: string | null,
  sources: readonly AskSource[],
  includeDiscussion = false,
  /**
   * The settlements the page's own feed already follows (`AcpChatStore.hostSettlements`). Given, the ask is read off them
   * and nothing more is read from the machine; over a device link a second subscription doubles every push of the session.
   */
  held?: Readonly<Record<string, Settlement>> | null,
): Settlement | null {
  const [ask, setAsk] = useState<Settlement | null>(null);
  const following = held === undefined || held === null;
  const heldAsk = useMemo(
    () => (following || !sessionId ? null : askOf(held, sources, includeDiscussion)),
    [following, sessionId, held, sources, includeDiscussion],
  );
  useEffect(() => {
    setAsk(null);
    if (!sessionId || !following) return;
    let settlements: Readonly<Record<string, Settlement>> = {};
    const take = (next: Readonly<Record<string, Settlement>>) => {
      settlements = next;
      setAsk(askOf(settlements, sources, includeDiscussion));
    };
    const there = rpcOn(machineRegistry.machineOf(sessionId));
    let close = () => undefined as void;
    // @@@host-ask-reread - one snapshot + subscription per timeline generation. A batch that does not continue what is held
    // (`batchDiscontinuity`: another epoch — a new session's stand-in replaced by its real record — or skipped seqs) is
    // read again, by the same rule as the session page's own timeline (agent-watch-store `applyBatch`). A generation
    // closed before its snapshot or subscription lands takes nothing, and closes the subscription it opened late.
    const open = () => {
      close();
      const subscriptionId = crypto.randomUUID();
      let current = true;
      let cursor: RecordCursor | null = null;
      // Listen first: an ask between the snapshot and the subscription must not slip past.
      const off = events.on(sessionpageSessionTimelineChannel, (event: SessionpageSessionEvent) => {
        const result = event.result as TimelineAfterResult;
        if (!result.ok) {
          cursor = result.snapshot.cursor;
          take(mergeSettlements({}, result.snapshot.settlements));
          return;
        }
        const { batch } = result;
        if (batchDiscontinuity(cursor, batch)) return open();
        // Only a batch that moves forward may reopen an answered ask; a replay may not (`mergeSettlements`).
        const newer = !cursor || batch.cursor.seq > cursor.seq;
        if (newer) cursor = batch.cursor;
        take(mergeSettlements(settlements, batch.settlements, newer));
      }, subscriptionId);
      const unsubscribe = () => there.sessionTimeline.sessionUnsubscribe({ subscriptionId });
      close = () => {
        current = false;
        off();
        void unsubscribe().catch(() => undefined);
      };
      void (async () => {
        const snapshot = await there.sessionTimeline.sessionSnapshot({ conversationId: sessionId, limit: 1 });
        if (!current) return;
        if (!snapshot.ok) throw new Error(`sessionSnapshot refused: ${snapshot.error.code}: ${snapshot.error.message}`);
        cursor = snapshot.value.cursor;
        take(mergeSettlements({}, snapshot.value.settlements));
        const subscribed = await there.sessionTimeline.sessionSubscribe({ conversationId: sessionId, subscriptionId, cursor: snapshot.value.cursor, terminalPatch: true });
        // Closed while subscribing: its unsubscribe went first, so this subscription would stay open with nobody listening.
        if (!current) return void await unsubscribe();
        if (!subscribed.ok) throw new Error(`sessionSubscribe refused: ${subscribed.error.code}: ${subscribed.error.message}`);
      })().catch((error: unknown) =>
        log.warn('Host asks of this session could not be read', { sessionId, error: error instanceof Error ? error.message : String(error) })
      );
    };
    open();
    return () => close();
  }, [sessionId, sources, includeDiscussion, following]);
  return following ? ask : heldAsk;
}

function askOf(settlements: Readonly<Record<string, Settlement>>, sources: readonly AskSource[], includeDiscussion: boolean): Settlement | null {
  return includeDiscussion
    ? latestAgentQuestion(Object.fromEntries(Object.entries(settlements).filter(([, item]) => item.origin && sources.includes(item.origin.source))))
    : pendingHostAsk(settlements, sources);
}

/**
 * D-31 That ask as the session's approval band — one band, read and answered one way, on a chat-UI session's composer and
 * under a terminal session's terminal (125 10-06: whoever watches the session on the session page answers it there). Who asks
 * for what; 「不装」 answers at once, 「查看并安装」 opens this device's own sheet (naming the machine the session runs on when
 * that is another one); the answer goes to the session's `respond`, and 「已经不等了」 when the ask was withdrawn first.
 * The timeline is read only while the session waits on an approval (`session`: its status as the host wrote it) — an open
 * panel reads nothing otherwise.
 */
export function useHostAskBand(
  sessionId: string | null,
  session: { status: string | null; detail: string | null } | null | undefined
): { request: ComposerPermissionRequest; resolve: (optionId: string | null) => void } | null {
  const { translate } = useSessionMessages();
  const ask = useSessionHostAsk(sessionWaitsOnApproval(session) ? sessionId : null, HOST_APPROVALS);
  const install = appInstallAskOf(ask?.origin);
  const capability = deviceCapabilityAskOf(ask?.origin);
  const itemId = ask?.itemId;
  const machineId = sessionId ? machineRegistry.machineOf(sessionId) : null;
  const machine = machineId ? remoteHostsStore.device(machineId)?.label ?? machineId : undefined;
  const resolve = useCallback(
    (optionId: string | null) => {
      if (!optionId || !sessionId || !itemId || (!install && !capability)) return;
      const respond = async (answer: { optionId: string; digest?: string }) => {
        const result = await rpc.sessionTimeline.sessionRespond({ conversationId: sessionId, itemId, kind: 'permission', by: 'desktop', ...answer });
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return result;
      };
      void (install ? answerAppInstall({ itemId, ask: install, optionId, machine, respond }) : respond({ optionId }))
        .then((result) => {
          if (answeredTooLate(result)) toast({ title: translate('extensions.consentNoLongerWaiting') });
        })
        .catch((error: unknown) => {
          const title = error instanceof Error && 'code' in error && error.code === 'session_not_found'
            ? translate('remoteHost.condition.sessionGone', { device: machine ?? translate('task.deviceLocal') })
            : error instanceof Error ? error.message : String(error);
          toast({ title, variant: 'destructive' });
        });
    },
    [sessionId, itemId, install, capability, machine, translate]
  );
  if (!ask || (!install && !capability)) return null;
  const words = install ? appInstallWords(install, translate, machine) : deviceCapabilityWords(capability!, translate, machine);
  return {
    request: {
      requestId: ask.itemId,
      title: words.title,
      statusLabel: translate('composer.awaitingApproval'),
      options: (ask.options ?? []).map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind ?? '',
        label: words.label(option.optionId),
      })),
    },
    resolve,
  };
}
