import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { codexOAuthIdentity } from '@gugu/core/local/codex-native-auth.mjs';
import { assertCodexFileCredentialStore, codexAuthIdentity } from './codex-auth-slot';

export type CodexReferenceRow = { accountId: string; isDefault: boolean; updatedAt: number; meta: {
  displayName?: string; harnessConnection?: { kind: 'native' | 'account' | 'api-key'; removed?: boolean; migratedTo?: string;
    nativeOAuth?: { root: string; identity: string; operationId: string } };
} | null };
export type CodexReferenceCommit = {
  operationId: string; identity: string; root: string; expected: CodexReferenceRow[];
  aliases: string[]; retained: { id: string; name: string }[]; defaultId: string;
};
type Move = { path: string; destination: string; hash: string; discard: boolean };
type Journal = { version: 1; commit: CodexReferenceCommit; moves: Move[] };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };

async function document(path: string): Promise<{ text: string; identity: string | null } | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error('Codex credential migration requires a private regular file');
    const text = await readFile(path, 'utf8');
    return { text, identity: codexOAuthIdentity(JSON.parse(text)) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

async function sourceDocument(path: string): Promise<{ text: string; identity: string | null } | null> {
  try { const text = await readFile(path, 'utf8'); return { text, identity: codexOAuthIdentity(JSON.parse(text)) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Prepared journal contains paths/hashes/identity only. Files move; OAuth is never copied. */
export async function reconcileCodexNativeReference(options: {
  sourceRoot: string; managedRoot: string; stateRoot: string;
  vaultRoot(id: string): string; rows(): Promise<CodexReferenceRow[]>;
  commit(value: CodexReferenceCommit): Promise<void>;
  beforeMove(): Promise<void>;
  checkpoint?: (stage: string) => Promise<void>;
}): Promise<boolean> {
  await assertCodexFileCredentialStore(options.sourceRoot);
  await assertCodexFileCredentialStore(options.managedRoot);
  const { stateRoot } = options;
  const journalPath = join(stateRoot, 'native-oauth-reference.json');
  let journal: Journal | null = null;
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const source = await realpath(options.sourceRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && !journal) return null; throw error;
  });
  if (!source) return false;
  const native = await sourceDocument(join(source, 'auth.json'));
  if (!native?.identity) {
    if (journal) throw new Error('Native Codex account changed during credential migration; retry with the original account');
    return false;
  }
  const sourceFile = await realpath(join(source, 'auth.json'));
  const owned = await Promise.all([options.managedRoot, stateRoot].map(async root => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const canonical = await realpath(root);
    if (canonical === source || inside(source, canonical) || inside(canonical, source)) throw new Error('Native and Gugu credential directories must be separate');
    return { root, canonical };
  }));
  const verifyOwned = async (path: string) => {
    if (!owned.some(({ root, canonical }) => inside(root, path) || inside(canonical, path))) throw new Error('Credential migration path is outside Gugu storage');
    const parent = await realpath(dirname(path));
    if (!owned.some(({ canonical }) => parent === canonical || inside(canonical, parent)) || parent === source || inside(source, parent)) {
      throw new Error('Credential migration cannot traverse a directory link');
    }
    const target = await realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (target === sourceFile) throw new Error('Gugu credential migration cannot modify the native credential authority');
  };
  if (!journal) {
    const rows = await options.rows();
    const selected = rows.find(row => row.isDefault)?.accountId ?? 'native';
    const op = randomUUID();
    const aliases = new Set<string>();
    const retained = new Map<string, { id: string; name: string }>();
    let defaultId = selected;
    const moves: Move[] = [];
    const reference = rows.find(row => row.accountId === 'native')?.meta?.harnessConnection?.nativeOAuth;
    const live = await document(join(options.managedRoot, 'auth.json'));
    const known = new Map<string, string>();
    for (const row of rows.filter(row => row.accountId !== 'native' && !row.meta?.harnessConnection?.removed && row.meta?.harnessConnection?.kind === 'account')) {
      const saved = await document(join(options.vaultRoot(row.accountId), 'auth.json'));
      if (saved?.identity && !known.has(saved.identity)) known.set(saved.identity, row.accountId);
    }
    let liveOwner = reference ? 'managed-live' : 'native';
    try {
      const recorded = JSON.parse(await readFile(join(stateRoot, 'managed-live-account.json'), 'utf8')) as { connectionId?: string; identity?: string };
      if (live && recorded.identity === codexAuthIdentity(JSON.parse(live.text)) && recorded.connectionId !== 'native'
        && rows.some(row => row.accountId === recorded.connectionId)) {
        liveOwner = recorded.connectionId!;
        if (live.identity) known.set(live.identity, liveOwner);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (live?.identity && known.has(live.identity)) liveOwner = known.get(live.identity)!;
    if (!reference && selected === 'native' && liveOwner !== 'native') defaultId = liveOwner;
    const candidates = [
      { id: liveOwner, path: join(options.managedRoot, 'auth.json') },
      ...rows.filter(row => row.meta?.harnessConnection?.kind !== 'api-key').map(row => ({ id: row.accountId, path: join(options.vaultRoot(row.accountId), 'auth.json') })),
      { id: 'native', path: join(stateRoot, 'native', '.codex', 'auth.json') },
    ];
    for (const candidate of candidates) {
      const value = await document(candidate.path);
      if (!value?.identity) continue;
      await verifyOwned(candidate.path);
      if (value.identity === native.identity) {
        if (candidate.id !== 'native' && candidate.id !== 'managed-live') aliases.add(candidate.id);
        if (selected === candidate.id) defaultId = 'native';
        moves.push({ path: candidate.path, destination: join(stateRoot, 'native-oauth-removed', op, `${moves.length}.json`), hash: digest(value.text), discard: true });
      } else if (candidate.id === 'native') {
        // An independent Gugu sign-in must survive when the terminal uses another account.
        if (known.has(value.identity)) {
          moves.push({ path: candidate.path, destination: join(stateRoot, 'native-oauth-removed', op, `${moves.length}.json`), hash: digest(value.text), discard: true });
          continue;
        }
        const id = `local-${digest(value.identity).slice(0, 32)}`;
        const destination = join(options.vaultRoot(id), 'auth.json');
        if (moves.some(move => move.destination === destination && !move.discard)) {
          // The live managed generation comes first; a leftover inactive copy is not a second account.
          moves.push({ path: candidate.path, destination: join(stateRoot, 'native-oauth-removed', op, `${moves.length}.json`), hash: digest(value.text), discard: true });
          continue;
        }
        const existing = await document(destination);
        if (existing && digest(existing.text) !== digest(value.text)) throw new Error('Independent Codex sign-in already has different credentials; retry after selecting its account');
        retained.set(id, { id, name: 'Codex account' });
        if (candidate.path === join(options.managedRoot, 'auth.json') && selected === 'native') defaultId = id;
        moves.push({ path: candidate.path, destination, hash: digest(value.text), discard: false });
      }
    }
    if (aliases.has(defaultId)) defaultId = 'native';
    const current = rows.find(row => row.accountId === 'native')?.meta?.harnessConnection?.nativeOAuth;
    if (!moves.length && current?.root === source && current.identity === native.identity) return true;
    journal = { version: 1, commit: { operationId: op, identity: native.identity, root: source, expected: rows,
      aliases: [...aliases], retained: [...retained.values()], defaultId }, moves };
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const temporary = `${journalPath}.${op}`;
    await writeFile(temporary, JSON.stringify(journal), { mode: 0o600, flag: 'wx' });
    await rename(temporary, journalPath);
    await options.checkpoint?.('prepared');
  }
  if (journal.version !== 1 || journal.commit.root !== source || journal.commit.identity !== native.identity
    || !Array.isArray(journal.moves)) throw new Error('Codex credential migration journal does not match the native account');
  await options.beforeMove();
  for (const move of journal.moves) {
    await verifyOwned(move.path);
    await mkdir(dirname(move.destination), { recursive: true, mode: 0o700 });
    await verifyOwned(move.destination);
    // Reread before every mutation. Another CLI's source rotation is fine; another account is not.
    if ((await sourceDocument(join(source, 'auth.json')))?.identity !== journal.commit.identity) throw new Error('Native Codex account changed during migration');
    const current = await document(move.path);
    const moved = await document(move.destination);
    if (current && digest(current.text) !== move.hash || moved && digest(moved.text) !== move.hash) throw new Error('Gugu Codex credentials changed during migration; nothing further was removed');
    if (current) {
      if (moved) throw new Error('Credential migration destination already exists');
      await rename(move.path, move.destination);
    } else if (!moved && !move.discard) throw new Error('Independent Codex sign-in is missing during migration');
    await options.checkpoint?.('moved');
  }
  try { await options.commit(journal.commit); }
  catch (error) {
    // A registry CAS rejection publishes nothing. Restore staged files so a new attempt can prepare fresh metadata.
    const committed = (await options.rows()).find(row => row.accountId === 'native')?.meta?.harnessConnection?.nativeOAuth?.operationId === journal.commit.operationId;
    if (!committed) {
      for (const move of [...journal.moves].reverse()) {
        await verifyOwned(move.path); await verifyOwned(move.destination);
        const staged = await document(move.destination);
        if (!staged) continue;
        if (digest(staged.text) !== move.hash || await document(move.path)) throw new Error('Codex migration could not restore its staged credentials; the journal was retained');
        await rename(move.destination, move.path);
      }
      await rm(journalPath);
    }
    throw error;
  }
  await options.checkpoint?.('committed');
  for (const move of journal.moves.filter(move => move.discard)) {
    await verifyOwned(move.destination);
    const value = await document(move.destination);
    if (value && digest(value.text) !== move.hash) throw new Error('Quarantined Codex credentials changed; cleanup was deferred');
    await rm(move.destination, { force: true });
    await options.checkpoint?.('removed');
  }
  await rm(journalPath);
  return true;
}
