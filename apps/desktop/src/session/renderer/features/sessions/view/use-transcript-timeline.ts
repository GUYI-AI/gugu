import { chatActor } from '@renderer/lib/chat/actor-identity';
import { chatDisplayName } from '@renderer/lib/chat/chat-name';
import { readChatSummary, resolveChatId, subscribeChatNames } from '@/lib/chatSummariesBridge';
import { translateSessionMessage } from '../../../localization/locale-store';
import { useLayoutEffect, useRef, useState } from 'react';
import { createComputed, createMemo, createRoot, createSignal } from 'solid-js';
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import type { TimelineRailOptions } from '@gugu/core/shared/timelineRail';
import { pendingPromptTurn, type ChatSessionState, type SelfIdentity, type TranscriptApi, type TranscriptTurn } from '@gugu/session-chat-ui';
import { timelineTurnsFromOutline, timelineTurnsFromTranscript, type TimelineOutlineTurn, type TimelineTurn } from './session-timeline-turns';

/** How long name updates are gathered before the rail is reprojected once for all of them. */
const IDENTITY_REFRESH_MS = 50;

/** Bridge the existing Solid transcript into React, including text-only updates. */
export function useTranscriptTimeline<T>(
  transcript: TranscriptApi | undefined,
  selfIdentity: () => SelfIdentity | null,
  select: (turns: TimelineTurn[]) => T,
  /** 乐观行(发出了、真的那一轮还没开出)也算一格:刻度与左边那条车道从发出那一刻就在,交接时这一列不横移。 */
  session?: Pick<ChatSessionState, 'state'>,
  /** The turns older than the loaded ones, in outline: the rail then covers the whole conversation, not its loaded end. */
  outline?: readonly TimelineOutlineTurn[],
): T {
  const setOutline = useRef<((turns: readonly TimelineOutlineTurn[]) => void) | null>(null);
  const latestOutline = useRef(outline);
  latestOutline.current = outline;
  const [snapshot, setSnapshot] = useState<{
    transcript: TranscriptApi | undefined;
    value: T;
  }>({ transcript: undefined, value: select([]) });

  useLayoutEffect(() => {
    if (!transcript) return;
    return createRoot((dispose) => {
      const directory = readIdentityDirectoryBridge();
      const [identityRevision, setIdentityRevision] = createSignal(0);
      // Names arrive in bursts while older pages load (each page asks for the identities it meets). One reprojection
      // answers all of a burst.
      let identityRefresh: ReturnType<typeof setTimeout> | undefined;
      const refreshIdentity = () => {
        identityRefresh ??= setTimeout(() => { identityRefresh = undefined; setIdentityRevision((revision) => revision + 1); }, IDENTITY_REFRESH_MS);
      };
      const offDirectory = directory?.subscribe(refreshIdentity);
      const offChatNames = subscribeChatNames(refreshIdentity);
      const offSelf = readSelfIdentityBridge()?.subscribe(refreshIdentity);
      const options: TimelineRailOptions = {
        resolveSenderType: (fromId) => {
          if (!fromId.startsWith('user:')) return null;
          const id = fromId.slice(5);
          const identity = directory?.getSnapshot()?.[id];
          if (!identity) directory?.ensure([id]);
          return identity?.type;
        },
      };
      const activityContext = { get viewerId() { return selfIdentity()?.userId; }, actor: chatActor, chatName: chatDisplayName, translate: translateSessionMessage,
        chatKind: (id: string) => readChatSummary(resolveChatId(id) ?? id)?.kind ?? null };
      // The same lookups, noting when one came back empty: only a turn that met an unknown name can read differently
      // after a name update.
      let unknown = false;
      const noting = <A extends unknown[], R>(lookup: (...args: A) => R) => (...args: A): R => {
        const found = lookup(...args);
        if (found === undefined || found === null) unknown = true;
        return found;
      };
      const notingOptions: TimelineRailOptions = {
        resolveSenderType: (fromId) => {
          const type = options.resolveSenderType!(fromId);
          if (type === undefined) unknown = true;
          return type;
        },
      };
      const notingContext = { get viewerId() { return activityContext.viewerId; }, actor: noting(activityContext.actor), chatName: noting(activityContext.chatName),
        translate: activityContext.translate, chatKind: noting(activityContext.chatKind) };
      // Streaming only reprojects the active turn, not the entire history.
      // A committed turn is replaced, never edited, and the projection reads one turn at a time: keep each turn's
      // result. A landed page then costs its own turns, and a name update costs the turns that were waiting for a
      // name, not every loaded one.
      let projected = new WeakMap<TranscriptTurn, { turns: TimelineTurn[]; waitingAt: number | null }>();
      let projectedSelf: SelfIdentity | null | undefined;
      const committed = createMemo(() => {
        const revision = identityRevision(), self = selfIdentity();
        if (projectedSelf !== self) { projected = new WeakMap(); projectedSelf = self; }
        return transcript.state.committedTurns.flatMap((turn) => {
          const kept = projected.get(turn);
          if (kept && (kept.waitingAt === null || kept.waitingAt === revision)) return kept.turns;
          unknown = false;
          const turns = timelineTurnsFromTranscript([turn], self, notingOptions, notingContext);
          projected.set(turn, { turns, waitingAt: unknown ? revision : null });
          return turns;
        });
      });
      const active = createMemo(() => {
        identityRevision();
        const pending = session?.state.pendingPrompt;
        const turn = transcript.state.activeTurnSnapshot ?? (pending ? pendingPromptTurn(pending) : null);
        return timelineTurnsFromTranscript(turn ? [turn] : [], selfIdentity(), options, activityContext);
      });
      // What is loaded is drawn from the turns themselves; the outline only speaks for what is older than them.
      const [older, setOlder] = createSignal<readonly TimelineOutlineTurn[]>(latestOutline.current ?? []);
      setOutline.current = setOlder;
      const oldestLoaded = createMemo(() => transcript.state.committedTurns[0]?.seq);
      const unloaded = createMemo(() => {
        identityRevision();
        const from = oldestLoaded(), turns = older();
        if (!turns.length) return [];
        return timelineTurnsFromOutline(from === undefined ? turns : turns.filter((turn) => turn.seq < from), selfIdentity(), options);
      });
      const selected = createMemo(() => select([...unloaded(), ...committed(), ...active()]));
      createComputed(() => setSnapshot({ transcript, value: selected() }));
      return () => { setOutline.current = null; offDirectory?.(); offChatNames(); offSelf?.(); clearTimeout(identityRefresh); dispose(); };
    });
  }, [transcript, selfIdentity, select, session]);
  useLayoutEffect(() => { setOutline.current?.(outline ?? []); }, [outline]);

  return snapshot.transcript === transcript ? snapshot.value : select([]);
}
