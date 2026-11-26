/**
 * Pure helpers for mention pill display — display-name and path
 * extraction. Kept in a standalone module so they can be unit-tested without
 * a DOM environment.
 */

// ── Basename ──────────────────────────────────────────────────────────────────

/**
 * Return the last path segment of a POSIX or Windows path.
 *
 * @example
 * basename('src/components/foo.tsx') // 'foo.tsx'
 * basename('foo.tsx')                // 'foo.tsx'
 * basename('')                       // ''
 */
export function basename(path: string): string {
  if (!path) return '';
  // Normalize backslash separators.
  const normalized = path.replace(/\\/g, '/');
  const last = normalized.split('/').at(-1) ?? '';
  return last;
}

/**
 * Keep the basename in the primary label and show the distinguishing path
 * tail on a second line in the @ popup. This lets same-name files be told
 * apart without exposing an unreadable absolute path.
 */
export function compactMentionPath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  const tail = parts.slice(Math.max(0, parts.length - 3), -1);
  return `${parts.length > 3 ? '…/' : ''}${tail.join('/')}/`;
}
