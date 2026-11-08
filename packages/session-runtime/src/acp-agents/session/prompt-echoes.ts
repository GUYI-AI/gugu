import type { AcpTranscriptParser, NormalizedEvent } from '@gugu/session-core/acp';
import type { PromptRequest } from './prompt-request';

type UserMessage = Extract<NormalizedEvent, { kind: 'message' }>;
type Position = { turnId: string; afterItemId?: string };

/** Native echoes do not identify a host submission until its receipt names their exact ID. */
export class PromptEchoes {
  private readonly submitted = new Set<PromptRequest>();
  private readonly pending = new Map<string, { event: UserMessage; position: Position }>();
  private readonly bindings = new Map<string, UserMessage>();
  private retiring = false;

  get admissionClosed(): boolean { return this.retiring; }

  register(request: PromptRequest): void {
    if (this.retiring) throw new Error('ACP prompt admission is closed until executor teardown');
    this.submitted.add(request);
  }

  receive(event: UserMessage, transcript: AcpTranscriptParser, continueTurn: boolean): UserMessage | null {
    if (!event.messageId) return this.retiring ? null : event;
    const bound = this.bindings.get(event.messageId);
    if (bound) return this.update(bound, event, event.messageId);
    if (this.retiring && !this.submitted.size) return null;
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
    this.settle(request);
    this.bindings.set(nativeId, request.submitted);
    const event = this.update(request.submitted, echo.event, nativeId);
    transcript.placeUserMessage(event, echo.position);
    return event;
  }

  /** Settle only this dispatch; another retry can already own the same client message ID. */
  settle(request: PromptRequest, cause?: { code?: unknown }): void {
    this.submitted.delete(request);
    // The local watchdog abandoned the RPC, not the native input. Its executor must retire.
    if (cause?.code === 'prompt_admission_timeout') this.retiring = true;
  }

  clear(): void { this.submitted.clear(); this.pending.clear(); this.bindings.clear(); this.retiring = false; }

  private update(submitted: UserMessage, echo: UserMessage, nativeId: string): UserMessage {
    return { ...echo, ...submitted, contentMode: 'replace',
      _meta: { ...echo._meta, ...submitted._meta, guguNativeMessageId: nativeId } };
  }
}
