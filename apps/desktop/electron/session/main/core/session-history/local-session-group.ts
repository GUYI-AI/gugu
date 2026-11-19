import { isAbsolute } from 'node:path';
import { canonicalPath, placeUnder, type CanonicalPath } from '@gugu/session-core/files';
import { SESSION_HOME_SECTION_KEY, isSessionHomeDirectory } from '@shared/core/session-history/session-history';
import { findRepoRoot } from './repo-root';

export type LocalSessionGroup = { key: string | null; label: string | null };
/** A folder recorded on this machine (@@@group-folders): its path and the name a section shows. */
export type LocalGroupFolder = { path: CanonicalPath; name: string };

/**
 * The history list and Apps group native transcripts by the same recorded folders and repository boundaries. A
 * transcript's directory is the agent's own record of it: put in its one spelling here (`@@@canonical-path`), where it
 * enters, before it is compared with a folder's. The task home is not a folder a person picked: never a section.
 */
export function createLocalGroupOf(folders: LocalGroupFolder[]): (directory: string | null) => LocalSessionGroup {
  const projectPaths = [...new Map(folders.map((folder) => [folder.path, folder])).values()]
    .filter((folder) => !isSessionHomeDirectory(folder.path))
    .map((folder) => ({ key: folder.path, label: folder.name }))
    .sort((a, b) => b.key.length - a.key.length);
  const isAtOrUnder = (path: CanonicalPath, base: CanonicalPath) => placeUnder(base, path) !== null;
  return (named) => {
    if (!named) return { key: null, label: null };
    if (isSessionHomeDirectory(named)) return { key: SESSION_HOME_SECTION_KEY, label: null };
    if (!isAbsolute(named)) return { key: named, label: null };
    const directory = canonicalPath(named);
    const root = findRepoRoot(directory);
    const boundary = root ? canonicalPath(root) : directory;
    return projectPaths.find((project) => isAtOrUnder(directory, project.key) && isAtOrUnder(project.key, boundary))
      ?? { key: boundary, label: null };
  };
}
