import type { TurnFileRef } from '@gugu/session-core/session-record/contract';
import type { TurnAnnotation } from '@gugu/session-core/acp/client';
import type { AnnotatedSend } from '../annotations/session-annotations';

type ComposerSendPort = {
  started?(): void;
  unsettled(): boolean;
  waitForUploads(): Promise<void>;
  hasFailedAttachments(): boolean;
  files(): TurnFileRef[];
  status(value: 'waiting' | 'blocked' | null): void;
  deliver(text: string, files: TurnFileRef[], annotations?: TurnAnnotation[]): void | Promise<void>;
  committed(): void;
};

/** The editor keeps custody of its live draft until persistence succeeds; failures never rewrite it. */
export async function sendComposerInput({ text, annotations }: AnnotatedSend, port: ComposerSendPort): Promise<void> {
  if (text || annotations?.length || port.unsettled() || port.files().length) port.started?.();
  if (port.unsettled()) {
    port.status('waiting');
    await port.waitForUploads();
  }
  const failed = port.unsettled() || port.hasFailedAttachments();
  port.status(failed ? 'blocked' : null);
  if (failed) return;
  const files = port.files();
  if (!text && files.length === 0 && !annotations?.length) return;
  try { await port.deliver(text, files, annotations); } catch { return; }
  port.committed();
}
