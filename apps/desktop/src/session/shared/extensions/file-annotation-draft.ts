import { z } from 'zod';
import { fileRefOf } from './app-runtime-protocol';

const line = z.number().int().positive().max(10_000_000);
const selection = z.object({ startLine: line, endLine: line, text: z.string().min(1).max(16 * 1024) })
  .refine(range => range.endLine >= range.startLine);
const bounds = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().nonnegative(), height: z.number().finite().nonnegative(),
});
const point = z.object({
  rect: bounds,
  viewport: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive() }),
});
const fileAnnotationOpen = point.and(z.union([
  z.object({ id: z.string().uuid() }),
  z.object({ selection }),
]));

export type FileAnnotationOpen = z.infer<typeof fileAnnotationOpen>;
export type FileAnnotationMarkers = { path: string; markers: { id: string; number: number; startLine: number }[] };

export type FileAnnotationAsk = {
  sessionId: string;
  webContentsId: number;
  path: string | null;
  open?: FileAnnotationOpen;
};

export const EXTENSION_FILE_ANNOTATION_METHOD = 'extensions.fileAnnotation';

/** Only the caller's task workspace may be named. This never opens or writes the supplied path. */
export function annotationFilePath(file: unknown, workspace: string): string {
  const ref = fileRefOf(file);
  if (!('workspace' in ref) || ref.workspace !== workspace || !('id' in ref) || ref.id.length > 4096) {
    throw Object.assign(new Error('Annotation requires a file in this task workspace'), { code: 'denied' });
  }
  return ref.id;
}

export function parseFileAnnotation(input: unknown): FileAnnotationOpen {
  const parsed = fileAnnotationOpen.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error('Invalid file annotation selection'), { code: 'invalid' });
  return parsed.data;
}
