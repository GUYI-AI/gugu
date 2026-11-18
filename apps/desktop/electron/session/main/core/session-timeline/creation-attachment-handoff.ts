import { isDeepStrictEqual } from 'node:util';
import { attachmentCreationUnverified as unverified } from './creation-attachment-journal';

type Owner = { ownerId: string; deviceId: string };
/** Complete lazy loading first, then bind the original owner to the synchronous lifecycle epoch at custody. */
export async function handoffCreationAttachmentInput(expected: Owner,
  context: () => Promise<Owner>,
  load: () => Promise<{ capture(): () => void; send(assertOwner: () => void): Promise<void> }>,
): Promise<void> {
  const sender = await load();
  if (!isDeepStrictEqual(await context(), expected)) throw unverified('The original attachment input owner/device changed before custody');
  const assertOwner = sender.capture();
  assertOwner();
  await sender.send(assertOwner);
}
