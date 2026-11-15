declare const canonical: unique symbol;

/**
 * @@@canonical-path - a working-copy path in its one spelling on the machine it is on: every folder on the way resolved
 * (a link, an alias such as a server's `accounts/<id>` → `account`, macOS's `/var` → `/private/var`), the last part as named
 * (a file that is itself a link stays that link). Only `canonicalPath` (session-core `files/paths`) makes one, where a path
 * enters (a record written, a path an agent or a page names); everything past that compares them as plain strings.
 */
export type CanonicalPath = string & { readonly [canonical]: true };

/**
 * A canonical path as it arrives from the machine it is on (over a device link, from the account's records): that machine
 * made it with `canonicalPath`, this one cannot — it only takes the machine's word, as for every other fact of its own.
 * The only other way to the type; never for a path typed, guessed or joined here.
 */
export function receivedCanonicalPath(fromItsMachine: string): CanonicalPath {
  return fromItsMachine as CanonicalPath;
}

const separatorOf = (p: string) => (/^[A-Za-z]:\\/.test(p) || p.startsWith('\\\\') ? '\\' : '/');

/**
 * Where `file` is under `root`, both canonical paths of one machine: its relative path with `/` separators ('' for the
 * root itself); null when it is not under it. By name only: whether a link there leads out is `inWorkingCopy`'s question,
 * on the machine the file is on. Pure, so a window can place another machine's paths.
 */
export function placeUnder(root: CanonicalPath, file: CanonicalPath): string | null {
  if (file === root) return '';
  const sep = separatorOf(root);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!file.startsWith(prefix)) return null;
  const rest = file.slice(prefix.length);
  return sep === '/' ? rest : rest.split(sep).join('/');
}
