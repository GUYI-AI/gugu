import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import type { SessionAnnotation } from './session-annotations';

const PREFIX = 'annotation-image:';
export function isAnnotationImage(id: string): boolean { return id.startsWith(PREFIX); }
export function annotationImageId(id: string): string { return PREFIX + id; }
export function currentAnnotationImages(items: readonly SessionAnnotation[], attachments: ComposerAttachment[]): ComposerAttachment[] {
  const keep = new Set(items.filter(item => item.kind === 'browser').map(item => annotationImageId(item.id)));
  return attachments.filter(item => !isAnnotationImage(item.id) || keep.has(item.id));
}

/** Reuses the composer's real upload ledger. The annotation count is its visible attachment. */
export function prepareAnnotationImages(items: readonly SessionAnnotation[], uploads: {
  has(id: string): boolean;
  add(chip: ComposerAttachment, file: File): Promise<boolean>;
}): void {
  for (const item of items) {
    if (item.kind !== 'browser') continue;
    const id = annotationImageId(item.id);
    if (!uploads.has(id)) void uploads.add({ id, name: item.screenshot.name, kind: 'image', mimeType: 'image/png' }, item.screenshot);
  }
}
