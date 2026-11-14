import type { ComposerAttachment } from '@gugu/session-ui/react/components';
import type { SessionAnnotation } from './session-annotations';

const PREFIX = 'annotation-image:';
export function isAnnotationImage(id: string): boolean { return id.startsWith(PREFIX); }

/** Reuses the composer's real upload ledger. The annotation count is its visible attachment. */
export function prepareAnnotationImages(items: readonly SessionAnnotation[], uploads: {
  has(id: string): boolean;
  add(chip: ComposerAttachment, file: File): Promise<boolean>;
}): void {
  for (const item of items) {
    if (item.kind !== 'browser') continue;
    const id = PREFIX + item.id;
    if (!uploads.has(id)) void uploads.add({ id, name: item.screenshot.name, kind: 'image', mimeType: 'image/png' }, item.screenshot);
  }
}
