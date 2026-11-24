import { z } from 'zod';

/**
 * One comment a person left on something they were looking at (a page, an HTML file, a diff line), sent beside their
 * words. The person sees `target` and `comment` as a card; the agent reads `promptText` (where it is, what was selected).
 *
 * Unlike a turn file's `promptText` — host context (local paths, how to send the file again) that stays out of the
 * transcript — this text is the sender's own: written by the composer from the person's comment and what they selected,
 * with nothing of the host in it. It stays with the message, never drawn, so a resend of the message carries it again.
 */
export const turnAnnotationSchema = z.object({
  number: z.number().int().min(1),
  /** What the comment points at, as the composer showed it: a file path, a page address, a diff file. */
  target: z.string().min(1),
  comment: z.string(),
  promptText: z.string().min(1),
});
export type TurnAnnotation = z.infer<typeof turnAnnotationSchema>;

/** The agent's one text block for a message's annotations, ahead of the person's own words. */
export function annotationPromptText(annotations: readonly TurnAnnotation[] | undefined): string | null {
  return annotations?.length ? annotations.map(annotation => annotation.promptText).join('\n\n') : null;
}
