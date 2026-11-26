import { inlineImageParts } from '@gugu/session-ui/react/components';
import type { TurnFileRef } from '@gugu/session-core/session-record/contract';

/** The chips in the order the turn carries them: the pictures in the words first, in their order, then the rest. */
export function inlineImageOrder(text: string, chipIds: readonly string[]): string[] {
  const placed = inlineImageParts(text).flatMap((part) => 'imageId' in part && chipIds.includes(part.imageId) ? [part.imageId] : []);
  return [...new Set(placed), ...chipIds.filter((id) => !placed.includes(id))];
}

/**
 * The words as the agent and the transcript get them: each picture placed in them names its folder file at its place,
 * `![Image N](gugu-file://<id>?v=<n>)`, N counted in document order as the composer's chip shows it. The runtime puts the
 * picture there (session-runtime `inline-images.ts`); the transcript draws it as a chip that opens the file.
 * A picture the composer no longer holds leaves no trace.
 */
export function inlineImageTurnText(text: string, fileOf: (chipId: string) => TurnFileRef | undefined, label: string): string {
  let n = 0;
  return inlineImageParts(text).map((part) => {
    if ('text' in part) return part.text;
    const file = fileOf(part.imageId);
    return file ? `![${label} ${++n}](gugu-file://${file.itemId}?v=${file.version})` : '';
  }).join('');
}
