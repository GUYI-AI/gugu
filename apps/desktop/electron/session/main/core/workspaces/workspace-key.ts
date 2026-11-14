import crypto from 'node:crypto';
import type { CanonicalPath } from '@gugu/session-core/files';

export function computeWorkspaceKey(absolutePath: CanonicalPath): string {
  return crypto.createHash('sha256').update(`local:${absolutePath}`).digest('hex');
}
