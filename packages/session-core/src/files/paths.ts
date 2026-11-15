import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { placeUnder, type CanonicalPath } from '@gugu/session-shared/canonical-path';
import { err, ok, type Result } from '@gugu/session-shared';
import type { FileError } from './errors';

export type AbsPath = string;

export function validateAbsolutePath(input: string): Result<AbsPath, FileError> {
  if (input.includes('\0')) {
    return err({ type: 'invalid-path', path: input, message: 'Path contains a null byte' });
  }
  if (!path.isAbsolute(input) && !path.win32.isAbsolute(input)) {
    return err({ type: 'invalid-path', path: input, message: 'Path must be absolute' });
  }
  return ok(path.normalize(input));
}

export function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

const real = (p: string) => realpathSync.native(p);

/**
 * The one way to a `CanonicalPath` (`@@@canonical-path`): an absolute path of this machine, its folders resolved, its last
 * part as named. A folder (or a link to one) is resolved whole, so a folder link out of a working copy lands outside it; a
 * file that is a link keeps its own name. A path not there yet keeps what is missing as named, under the real path of the
 * nearest folder that is there. Called where a path enters, never per change.
 * With `entry`, the last part is kept as named even when it is a folder or a link to one: the entry itself, not where it leads.
 */
export function canonicalPath(input: string, options: { entry?: boolean } = {}): CanonicalPath {
  if (input.includes('\0') || !path.isAbsolute(input)) throw new Error(`Not an absolute path: ${input}`);
  const absolute = path.resolve(input);
  // `entry`: the entry itself (to remove or rename it) — its folder resolved, its own name kept even when it is a folder link.
  const isFolder = !options.entry && (() => { try { return statSync(absolute).isDirectory(); } catch { return false; } })();
  if (isFolder) return real(absolute) as CanonicalPath;
  const missing: string[] = [path.basename(absolute)];
  let folder = path.dirname(absolute);
  for (;;) {
    try {
      return path.join(real(folder), ...missing) as CanonicalPath;
    } catch {
      const parent = path.dirname(folder);
      if (parent === folder) return absolute as CanonicalPath;
      missing.unshift(path.basename(folder));
      folder = parent;
    }
  }
}

/**
 * @@@working-copy-containment - the one answer to "is this file in that working copy": its relative path with `/`
 * separators, or null. Placed by name (`placeUnder`); a file there that is a link counts only if what it leads to is in the
 * working copy too, so a link out of it is never a way out. Every read, write, watch and bind of a working-copy file asks here.
 */
export function inWorkingCopy(root: CanonicalPath, file: CanonicalPath): string | null {
  const rel = placeUnder(root, file);
  if (rel === null) return null;
  const isLink = (() => { try { return lstatSync(file).isSymbolicLink(); } catch { return false; } })();
  if (!isLink) return rel;
  try {
    return placeUnder(root, real(file) as CanonicalPath) === null ? null : rel;
  } catch {
    // A link to nothing leads nowhere: no way out through it.
    return rel;
  }
}
