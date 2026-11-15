import { z } from 'zod';
import type { TranscriptTurn } from '../acp/client';
import type { SendAddresses } from './send-addresses';

const sender = z.object({
  fromId: z.string().nullable(), from: z.string().nullable(), fromType: z.string().nullable().optional(),
});
const addresses: z.ZodType<SendAddresses> = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), conversationId: z.string().nullable(), chatId: z.string().optional(),
      threadRootId: z.string().nullable(), whisper: z.boolean(), peer: z.string().optional(), recipientUserId: z.string().optional() }),
    z.object({ kind: z.literal('session'), count: z.number() }),
  ]),
  recipients: z.array(z.string()).nullable(), recipientsExplicit: z.boolean().optional(),
  chatKind: z.string().nullable(), confirmed: z.boolean(),
  replyTo: z.object({ fromId: z.string().nullable(), fromType: z.string().nullable().optional(), messageId: z.string().nullable() }).nullable(),
});

/** Identity/address facts only. Reply previews and envelope context never enter this protocol. */
export const previewActivitySourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('received'), id: z.string(), facts: z.array(sender.nullable()) }),
  z.object({ kind: z.literal('sent'), id: z.string(), addresses: addresses.nullable() }),
]);
export type PreviewActivitySource = z.infer<typeof previewActivitySourceSchema>;
export type PreviewActivitySources = (turn: TranscriptTurn) => ReadonlyMap<string, PreviewActivitySource | null>;
export type PreviewActivity = { activityVersion?: 1; activity?: PreviewActivitySource | null };

/** Absence is an older producer, never evidence of an owner conversation. */
export function hasPreviewActivity(value: PreviewActivity): value is { activityVersion: 1; activity: PreviewActivitySource | null } {
  return value.activityVersion === 1 && value.activity !== undefined;
}
