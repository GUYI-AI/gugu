/** Remote paths are POSIX and always absolute; the picker never shows a relative one. */

export function normalizePath(path: string | undefined) {
  const trimmed = path?.trim() || '/';
  const absolutePath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return absolutePath === '/' ? absolutePath : absolutePath.replace(/\/+$/, '');
}

export function parentPath(path: string) {
  if (path === '/') return '/';
  return path.split('/').slice(0, -1).join('/') || '/';
}
