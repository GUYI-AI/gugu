import type { AcpTranscriptParser, NormalizedEvent } from '@gugu/session-core/acp';
import type { PromptRequest } from './prompt-request';

type UserMessage = Extract<NormalizedEvent, { kind: 'message' }>;
type Position = { turnId: string; afterItemId?: string };

/** Native echoes do not identify a host submission until its receipt names their exact ID. */
export class PromptEchoes {
  private readonly submitted = new Set<string>();
  private readonly pending = new Map<string, { event: UserMessage; position: Position }>();
  private readonly bindings = new Map<string, UserMessage>();

  register(request: PromptRequest): void { this.submitted.add(request.messageId); }

  receive(event: UserMessage, transcript: AcpTranscriptParser, continueTurn: boolean): UserMessage | null {
    if (!event.messageId) return event;
    const bound = this.bindings.get(event.messageId);
    if (bound) return this.update(bound, event, event.messageId);
    const previous = this.pending.get(event.messageId);
    // An unconfirmed echo stays private through failure/retry until an exact receipt or teardown.
    if (!this.submitted.size && !previous) return event;
    this.pending.set(event.messageId, { position: previous?.position ?? transcript.reserveUserMessage(continueTurn),
      event: previous && event.contentMode === 'append'
        ? { ...previous.event, ...event, text: previous.event.text + event.text,
            content: [...(previous.event.content ?? []), ...(event.content ?? [])], contentMode: 'replace' }
        : event });
    return null;
  }

  accept(request: PromptRequest, nativeId: string, transcript: AcpTranscriptParser): UserMessage | undefined {
    const echo = this.pending.get(nativeId);
    if (!echo) return;
    this.pending.delete(nativeId);
    this.submitted.delete(request.messageId);
    this.bindings.set(nativeId, request.submitted);
    const event = this.update(request.submitted, echo.event, nativeId);
    transcript.placeUserMessage(event, echo.position);
    return event;
  }

  dispatched(request: PromptRequest): void { this.submitted.delete(request.messageId); }

  clear(): void { this.submitted.clear(); this.pending.clear(); this.bindings.clear(); }

  private update(submitted: UserMessage, echo: UserMessage, nativeId: string): UserMessage {
    return { ...echo, ...submitted, contentMode: 'replace',
      _meta: { ...echo._meta, ...submitted._meta, guguNativeMessageId: nativeId } };
  }
}
