import { chatActor } from '@renderer/lib/chat/actor-identity';
import { chatDisplayName } from '@renderer/lib/chat/chat-name';
import { readChatSummary, resolveChatId, subscribeChatNames } from '@/lib/chatSummariesBridge';
import { translateSessionMessage } from '../../../localization/locale-store';
import { useLayoutEffect, useState } from 'react';
import { createComputed, createMemo, createRoot, createSignal } from 'solid-js';
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import type { TimelineRailOptions } from '@gugu/core/shared/timelineRail';
import { pendingPromptTurn, type ChatSessionState, type SelfIdentity, type TranscriptApi, type TranscriptTurn } from '@gugu/session-chat-ui';
import { timelineTurnsFromTranscript, type TimelineTurn } from './session-timeline-turns';

/** How long name updates are gathered before the rail is reprojected once for all of them. */
const IDENTITY_REFRESH_MS = 50;

/** Bridge the existing Solid transcript into React, including text-only updates. */
export function useTranscriptTimeline<T>(
  transcript: TranscriptApi | undefined,
  selfIdentity: () => SelfIdentity | null,
  select: (turns: TimelineTurn[]) => T,
  /** 乐观行(发出了、真的那一轮还没开出)也算一格:刻度与左边那条车道从发出那一刻就在,交接时这一列不横移。 */
  session?: Pick<ChatSessionState, 'state'>,
): T {
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
      // Streaming only reprojects the active turn, not the entire history.
      // A committed turn is replaced, never edited, and the projection reads one turn at a time: keep each turn's
      // result until the names it was drawn with change. A landed page then costs its own turns, not every loaded one.
      let projected = new WeakMap<TranscriptTurn, TimelineTurn[]>();
      let projectedFor: readonly unknown[] = [];
      const committed = createMemo(() => {
        const revision = identityRevision(), self = selfIdentity();
        if (projectedFor[0] !== revision || projectedFor[1] !== self) { projected = new WeakMap(); projectedFor = [revision, self]; }
        return transcript.state.committedTurns.flatMap((turn) => {
          let turns = projected.get(turn);
          if (!turns) projected.set(turn, turns = timelineTurnsFromTranscript([turn], self, options, activityContext));
          return turns;
        });
      });
      const active = createMemo(() => {
        identityRevision();
        const pending = session?.state.pendingPrompt;
        const turn = transcript.state.activeTurnSnapshot ?? (pending ? pendingPromptTurn(pending) : null);
        return timelineTurnsFromTranscript(turn ? [turn] : [], selfIdentity(), options, activityContext);
      });
      const selected = createMemo(() => select([...committed(), ...active()]));
      createComputed(() => setSnapshot({ transcript, value: selected() }));
      return () => { offDirectory?.(); offChatNames(); offSelf?.(); clearTimeout(identityRefresh); dispose(); };
    });
  }, [transcript, selfIdentity, select, session]);

  return snapshot.transcript === transcript ? snapshot.value : select([]);
}
