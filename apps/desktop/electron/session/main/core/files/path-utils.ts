import path from 'node:path';

export function isAbsoluteMachinePath(filePath: string): boolean {
  return path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath);
}

export function joinMachinePath(basePath: string, ...segments: string[]): string {
  let current = basePath;
  for (const segment of segments) {
    const normalized = segment.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) continue;
    current =
      current.endsWith('/') || current.endsWith('\\')
        ? `${current}${normalized}`
        : `${current}/${normalized}`;
  }
  return current;
}
