import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// The containment check reads `relative` the way Windows does: '..\\gugu-managed', never '../gugu-managed'.
// join/dirname stay native so the fixture still lives on this disk.
vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>();
  const windows = { ...path, relative: path.win32.relative, isAbsolute: path.win32.isAbsolute, sep: path.win32.sep };
  return { ...windows, default: windows };
});

const { reconcileCodexNativeReference } = await import('./codex-native-auth-migration');

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function auth(person: string) {
  const jwt = (value: unknown) => `h.${Buffer.from(JSON.stringify(value)).toString('base64url')}.s`;
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: jwt({ sub: person,
    'https://api.openai.com/auth': { chatgpt_account_id: 'workspace' } }), account_id: 'workspace', refresh_token: 'private-fixture-refresh' } });
}

// The reporter's layout: source C:\Users\PC9\.codex, managed C:\Users\PC9\.gugu\agent-homes\codex\.codex.
// Under Windows rules relative(source, managed) is '..\.gugu\agent-homes\codex\.codex'; the old check read it as nested.
it.each([
  ['the reporter\'s home layout', ['.codex'], ['.gugu', 'agent-homes', 'codex', '.codex'], ['AppData', 'Roaming', 'gugu', 'harness-connections', 'codex']],
  ['sibling directories', ['.codex'], ['AppData', 'Roaming', 'gugu', 'codex'], ['AppData', 'Roaming', 'gugu', 'codex-state']],
])('treats native and Gugu credential directories as separate under Windows path rules: %s', async (_name, source, managed, state) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-native-reference-win32-')); roots.push(root);
  const home = join(root, 'Users', 'PC9');
  const sourceRoot = join(home, ...source);
  const managedRoot = join(home, ...managed);
  const stateRoot = join(home, ...state);
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, 'auth.json'), auth('person'));
  const result = reconcileCodexNativeReference({
    sourceRoot, managedRoot, stateRoot,
    vaultRoot: (id) => join(stateRoot, id, '.codex'),
    rows: async () => [{ accountId: 'native', isDefault: true, updatedAt: 1, meta: { harnessConnection: { kind: 'native' } } }],
    commit: vi.fn(async () => undefined),
    beforeMove: vi.fn(async () => undefined),
  });
  await expect(result).resolves.toBe(true);
});
