import { canonicalPath, inWorkingCopy } from '@gugu/session-core/files';
import * as path from 'node:path';

/**
 * Whether a relative path stays inside a root, symlinks included.
 *
 * One implementation, because two copies of a containment check drift and the
 * copy that drifts is the one that stops refusing. Its callers — a task's files
 * (`local-files`, `sessionFileOf`) and the icon reader — take the same supplied strings and
 * need the same answer; they differ only in how they report a refusal, which is
 * why this returns a boolean instead of throwing. Refs #2374.
 */
export function resolvesInside(root: string, relative: string): string | null {
  if (typeof relative !== 'string' || relative.length === 0) return null;
  if (path.isAbsolute(relative)) return null;
  // The one containment check (`@@@working-copy-containment`): both sides canonical, by name, and a link that leads out
  // (at any level) is outside. macOS's `/var` → `/private/var` is resolved on both sides alike.
  const base = canonicalPath(path.resolve(root));
  const target = canonicalPath(path.resolve(base, relative));
  return inWorkingCopy(base, target) === null ? null : target;
}
