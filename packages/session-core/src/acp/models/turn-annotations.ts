import { z } from 'zod';

/**
 * One comment a person left on something they were looking at (a page, an HTML file, a diff line), sent with their
 * message. The person reads `target` and `comment`; the agent reads `promptText` (where it is, what was selected),
 * which never enters the transcript — the same split as a turn file's `promptText`.
 */
export const transcriptAnnotationSchema = z.object({
  number: z.number().int().min(1),
  /** What the comment points at, as the composer showed it: a file path, a page address, a diff file. */
  target: z.string().min(1),
  comment: z.string(),
});
export type TranscriptAnnotation = z.infer<typeof transcriptAnnotationSchema>;

export const promptAnnotationSchema = transcriptAnnotationSchema.extend({ promptText: z.string().min(1) });
export type PromptAnnotation = z.infer<typeof promptAnnotationSchema>;

/** What the person sees of an annotation. */
export function transcriptAnnotation({ number, target, comment }: TranscriptAnnotation): TranscriptAnnotation {
  return { number, target, comment };
}

/** The agent's one text block for a message's annotations, ahead of the person's own words. */
export function annotationPromptText(annotations: readonly PromptAnnotation[] | undefined): string | null {
  return annotations?.length ? annotations.map(annotation => annotation.promptText).join('\n\n') : null;
}
