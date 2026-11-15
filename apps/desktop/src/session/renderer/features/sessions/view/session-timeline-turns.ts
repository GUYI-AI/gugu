import { activityPreviewLabel, activityPreviewSources } from '@gugu/session-chat-ui/activity-preview';
import { messageReferenceId } from '@gugu/session-core/acp/client';
import { isAppRoute, readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { timelineRailAdmits, timelineRailMessages, timelineRailPreviewText, type TimelineRailOptions } from '@gugu/core/shared/timelineRail';
import { shownSender, type SelfIdentity, type TranscriptTurn } from '@gugu/session-chat-ui';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import type { StoredOutlineTurn } from '@shared/core/sessions/session-outline';

/**
 * Who a delivered turn came from. The rail paints these ticks differently from
 * the user's own turns and names the sender in the preview (#4874, owner
 * 2026-09-04:「别人发过来的消息…要看出来消息来自于谁」— identical ticks made
 * the two indistinguishable).
 */
export type TimelineSender =
  | { kind: 'chat'; name: string }
  /** `chatId` 从来源链接里取(信封的 chat 是群号,给 agent 寻址用);名字由画的那一层按它去认。 */
  | { kind: 'group'; name: string; chatId: string | null }
  | { kind: 'session'; name: string }
  /** #6387 An installed extension, relaying what the person did in it. */
  | { kind: 'extension'; name: string }
  /** 咕咕 itself (a `system` notice), or a legacy / batched envelope that names nobody. */
  | { kind: 'gugu' };

/** One navigable input and the first reply before the next input. */
export interface TimelineTurn {
  id: string;
  /** Additional inputs can share a provider turn with the first input. */
  sourceTurnId?: string;
  /** Item to scroll to on click — the turn's first item, i.e. the prompt. */
  anchorItemId: string;
  /** Every item id of the turn: the rail maps the row under the reading line back to its turn by these. */
  itemIds: string[];
  prompt: string;
  reply: string;
  /** Absent for the user's own turns. */
  sender?: TimelineSender;
  /** Set while the turn is not loaded: the message's durable reference, which a jump asks the transcript to reveal. */
  reference?: string;
}

/** What the machine that keeps the conversation says about one turn this window has not loaded (`getStoredOutline`). */
export type TimelineOutlineTurn = StoredOutlineTurn;

function senderOf(facts: DeliveryReadFacts, self: SelfIdentity | null): TimelineSender {
  // #5048 the signed-in user's own delivered turn is named from the local profile, like the card.
  const name = shownSender(facts.from, facts.fromId, self);
  if (!name) return { kind: 'gugu' };
  if (facts.route === 'session-direct') return { kind: 'session', name };
  if (isAppRoute(facts.route)) return { kind: 'extension', name };
  if (facts.chatKind === 'group') return { kind: 'group', name, chatId: (facts.sourceLink && parseConversationLink(facts.sourceLink)?.chatId) || null };
  return { kind: 'chat', name };
}

/**
 * Provider turns can contain several user inputs (steer / chat deliveries).
 * Each input owns only the items up to the next input, so preview, reading
 * marker and jump all refer to the same message. Callers supply both history
 * and the active snapshot; completion is not a prerequisite for navigation.
 */
export function timelineTurnsFromTranscript(
  transcript: readonly TranscriptTurn[],
  self: SelfIdentity | null = null,
  options: TimelineRailOptions = {},
  activityContext?: Parameters<typeof activityPreviewLabel>[1],
): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  for (const turn of transcript) {
    const activitySources = activityContext ? activityPreviewSources(turn) : null;
    let current: TimelineTurn | undefined;
    let first = true;
    for (const item of turn.items) {
      if (item.kind === 'message' && item.role === 'user') {
        // Every input ends the preceding preview, including a hidden delivery.
        current = undefined;
        const firstInput = first;
        first = false;
        const delivery = readDeliveryEnvelope(item.text);
        if (turn.initiator !== 'user' && !delivery) continue;
        const humans = timelineRailMessages(item.text, { ...options, selfUserId: self?.userId ?? options.selfUserId });
        for (const [index, human] of humans.entries()) {
          const isFirst = firstInput && index === 0;
          current = {
            id: isFirst ? turn.id : `${turn.id}:${item.id}${index ? `:${index}` : ''}`,
            ...(isFirst ? {} : { sourceTurnId: turn.id }),
            anchorItemId: item.id,
            itemIds: [item.id],
            prompt: human.text,
            reply: '',
            ...(human.sender ? { sender: senderOf(human.sender, self) } : {}),
          };
          turns.push(current);
        }
        // A reply to a mixed batch cannot be attributed to any one human.
        if (delivery && delivery.segments.length !== humans.length) current = undefined;
        continue;
      }
      if (!current) continue;
      current.itemIds.push(item.id);
      if (!current.reply && item.kind === 'message' && item.role === 'assistant') {
        const folded = activitySources && activityPreviewLabel(activitySources.get(messageReferenceId(turn, item.id) ?? item.id), activityContext!) !== null;
        if (!folded) current.reply = timelineRailPreviewText(item.text);
      }
    }
  }
  return turns;
}

/**
 * The same entries for turns that are not loaded, from their outline. The machine listed every input some reader
 * could show; this reader's directory decides, as it does for loaded turns, and the ids are the ones the entries
 * will have once their turns load.
 */
export function timelineTurnsFromOutline(
  outline: readonly TimelineOutlineTurn[],
  self: SelfIdentity | null = null,
  options: TimelineRailOptions = {},
): TimelineTurn[] {
  const admit = { ...options, selfUserId: self?.userId ?? options.selfUserId };
  const turns: TimelineTurn[] = [];
  for (const turn of outline) for (const input of turn.inputs) {
    const humans = input.candidates.filter((candidate) => timelineRailAdmits({ sender: candidate.sender as DeliveryReadFacts | null }, admit));
    // A reply to a mixed batch cannot be attributed to any one human.
    const attributed = input.segments === null || input.segments === humans.length;
    for (const [index, human] of humans.entries()) {
      const isFirst = input.first && index === 0;
      turns.push({
        id: isFirst ? turn.id : `${turn.id}:${input.itemId}${index ? `:${index}` : ''}`,
        ...(isFirst ? {} : { sourceTurnId: turn.id }),
        anchorItemId: input.itemId,
        itemIds: [input.itemId],
        prompt: human.text,
        reply: attributed && index === humans.length - 1 ? input.reply : '',
        ...(human.sender ? { sender: senderOf(human.sender as DeliveryReadFacts, self) } : {}),
        reference: input.reference,
      });
    }
  }
  return turns;
}

/**
 * 画在轨道上的一格。轮数超过轨道站得下的格数时一格代表多轮(见 `turnsPerTick`),
 * 于是「一格 = 一轮」不再恒成立,`from`/`to` 说清它到底代表哪几轮(1 基,闭区间)。
 */
export interface TimelineTick {
  /** 代表这一格的那一轮:格子里有投递就取第一条投递,否则取头一轮。 */
  turn: TimelineTurn;
  from: number;
  to: number;
  /**
   * 这一格里有没有别人发来的。tone 认它而不是 `turn.sender` —— 否则一条投递被埋在
   * 格子中间就整格看不出来,而「要看出来消息来自于谁」是 owner 2026-09-04 定的。
   * 取第一条投递当代表,正是为了让 tone 与预览卡上的名字对得上。
   */
  delivered: boolean;
}

/** 按「一格 n 轮」把轮次切成格子:每一轮都归属某一格,❌ 没有一轮被丢在格子之外。 */
export function ticksFromTurns(
  turns: readonly TimelineTurn[],
  turnsPerTick: number
): TimelineTick[] {
  const stride = Math.max(1, Math.floor(turnsPerTick));
  const ticks: TimelineTick[] = [];
  for (let start = 0; start < turns.length; start += stride) {
    const group = turns.slice(start, start + stride);
    const delivered = group.find((turn) => turn.sender !== undefined);
    ticks.push({
      turn: delivered ?? group[0],
      from: start + 1,
      to: start + group.length,
      delivered: delivered !== undefined,
    });
  }
  return ticks;
}
