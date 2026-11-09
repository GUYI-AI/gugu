import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A file outside the working copy is read, and never written, only as the file a person opened in the page
 * (`@@@outside-file`), as the page's host stamps it. The machine the file is on says so (`fileRootOf`), whoever asks: a page
 * on this desktop, a page on another desktop (its call carried there in `app_call`), a page on the phone. Each case goes
 * through the function its host really calls, and the machine that answers parses the call as it arrives
 * (`parseAgentSessionRequest`) and answers it for real (`answerAppCall` → `machineVerbs` → the working copy's reads and
 * writes): only the device RPC itself is a loop here.
 */
const f = vi.hoisted(() => ({
  capabilities: new Set<string>(),
  root: '',
  /** Which machine is answering now: `there` is the one with the session (inside a cross-machine call). */
  side: 'here' as 'here' | 'there',
  answer: null as null | ((caller: unknown, action: unknown) => Promise<unknown>),
  parse: null as null | ((name: 'app_call', caller: unknown, action: unknown) => { caller: unknown; action: unknown } | { error: string }),
}));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, dialog: {}, shell: {} }));
vi.mock('@main/lib/events', () => ({ events: { on: () => () => undefined, emit: () => undefined } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined } }));
vi.mock('@main/core/app/service', () => ({ appService: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    hasCapability: (_app: string, cap: string) => f.capabilities.has(cap),
    isEnabled: () => true,
    get: () => ({ manifest: { id: 'reader', name: 'Reader', version: '1.0.0', contributes: { tabs: [] } } }),
  }),
  extensionDataRoot: () => f.root,
}));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: { agentToolsRefusal: () => null, callFromPage: vi.fn() } }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: { removed() {}, renamed() {} }, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
// The session is on this machine for `local`, and on the other one (`dev-there`) for the cross-machine cases.
const SESSION = '22222222-2222-4222-8222-222222222222';
const scene = vi.hoisted(() => ({ sessionOn: 'here' as 'here' | 'there' }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async () => (scene.sessionOn === f.side ? { workspaceRoot: f.root, projectId: 'p', workspaceId: 'w' } : null),
}));
/** The device RPC: the call arrives at the other machine as JSON, is parsed as it is there, and answered there. */
const across = async (caller: unknown, action: unknown) => {
  f.side = 'there';
  try {
    const parsed = f.parse!('app_call', JSON.parse(JSON.stringify(caller)), JSON.parse(JSON.stringify(action)));
    if ('error' in parsed) throw new Error(parsed.error);
    return await f.answer!(parsed.caller, parsed.action);
  } finally {
    f.side = 'here';
  }
};
vi.mock('@main/core/sessions/session-family', () => ({
  // As the real `appCall` sends it: this machine's id and label on the App's caller.
  otherMachines: () => ({
    appCall: (app: object, _device: string, action: unknown) => across({ kind: 'app', deviceId: 'dev-here', deviceLabel: 'here', ...app }, action),
    isThisDevice: async (id: string) => id === 'dev-here',
    sessionHome: async () => ({ found: { deviceId: 'dev-there', label: 'there', session: { conversationId: SESSION, projectId: 'p', agent: null }, listsAgents: true }, unreached: [] }),
  }),
}));
vi.mock('../../../../../src/mobile/agent-watch/sessionpage-rpc', () => ({ appCallOn: (_device: string, caller: unknown, action: unknown) => across(caller, action) }));

const { readAppFile, writeAppFileText } = await import('./app-files');
const { answerAppCall } = await import('./app-programs-elsewhere');
const { parseAgentSessionRequest } = await import('../../../../cross-machine-sessions');
f.parse = parseAgentSessionRequest as never;
const { callOnComputer } = await import('../../../../../src/components/appSlot/phoneProgramCall');
f.answer = answerAppCall as never;

const workspace = `session:${SESSION}`;
const DENIED = /Not permitted/;
let outside = '';
let home = '';
let file = '';

beforeEach(async () => {
  f.capabilities.clear();
  f.capabilities.add('files:read');
  f.root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'handed-root-')));
  outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'handed-out-')));
  home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'handed-home-')));
  vi.stubEnv('GUGU_HOME', home);
  file = path.join(outside, 'notes.md');
  fs.writeFileSync(file, 'outside');
  fs.writeFileSync(path.join(outside, 'id_ed25519'), 'canary');
  fs.writeFileSync(path.join(f.root, 'in.txt'), 'inside');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of [f.root, outside, home]) await fsp.rm(dir, { recursive: true, force: true });
});

const text = (chunk: { data: Uint8Array | string }) => typeof chunk.data === 'string' ? Buffer.from(chunk.data, 'base64').toString() : Buffer.from(chunk.data).toString();
/** A page as the host binds it: the file it was opened on, and whether a person opened it (`openedBy: 'person'`). */
const pageOn = (handed: string | null, openedBy: 'person' | 'host' | 'agent-working' = 'person') => ({
  pageId: 7, extensionId: 'reader',
  handed: handed === null ? null : { workspace, id: handed },
  ...(handed !== null && openedBy === 'person' ? { personOpened: true } : {}),
  ...(openedBy === 'agent-working' ? { asAgent: 'agent-1' } : {}),
}) as never;
const read = (page: never, id: string) => readAppFile(page, { ref: { workspace, id }, offset: 0, length: 100 });

/** Every way a page reads and writes, each against a machine that answers for real. */
function handedCases() {
  it('a file a person opened reads; one an agent or an App opened, or the page an agent works, does not', async () => {
    expect(text(await read(pageOn(file), file))).toBe('outside');
    await expect(read(pageOn(file, 'host'), file)).rejects.toThrow(DENIED);
    await expect(read(pageOn(file, 'agent-working'), file)).rejects.toThrow(DENIED);
    await expect(read(pageOn(null), file)).rejects.toThrow(DENIED);
    // Opened on one file, the stamp reaches no other.
    await expect(read(pageOn(file), path.join(outside, 'id_ed25519'))).rejects.toThrow(DENIED);
    expect(text(await read(pageOn(null), 'in.txt'))).toBe('inside');
  });

  it('a file a person opened is never written, even by an App that may write files: it stays as it was', async () => {
    f.capabilities.add('files:write');
    await expect(writeAppFileText(pageOn(file), { ref: { workspace, id: file }, text: 'overwritten' })).rejects.toThrow(/read-only/);
    expect(fs.readFileSync(file, 'utf8')).toBe('outside');
    // A new file of the working copy still saves.
    await writeAppFileText(pageOn(null), { ref: { workspace, id: 'new.txt' }, text: 'saved' });
    expect(fs.readFileSync(path.join(f.root, 'new.txt'), 'utf8')).toBe('saved');
  });
}

describe('a page on this desktop, the session here', () => {
  beforeEach(() => { scene.sessionOn = 'here'; });
  handedCases();
});

describe('a page on another desktop, the session on that machine', () => {
  beforeEach(() => {
    scene.sessionOn = 'there';
    f.capabilities.add('files:read:all-machines');
  });
  handedCases();

  const caller = { kind: 'app', deviceId: 'dev-here', deviceLabel: 'here', extensionId: 'reader', extensionName: 'Reader' };
  const call = (id: string, method: string, args: Record<string, unknown>, handed: unknown) =>
    across(caller, { action: 'app_call', call_id: id, session_id: SESSION, version: '1.0.0', method, args, handed });

  it('the stamp crosses as the call is parsed there, and reaches only its own file of its own working copy', async () => {
    const args = { ref: { workspace, id: file }, offset: 0, length: 100 };
    expect(text(await call('stamped', 'filesRead', args, { workspace, id: file }) as never)).toBe('outside');
    await expect(call('other-copy', 'filesRead', args, { workspace: 'session:another', id: file })).rejects.toThrow(DENIED);
    await expect(call('other-file', 'filesRead', args, { workspace, id: path.join(outside, 'id_ed25519') })).rejects.toThrow(DENIED);
    await expect(call('malformed', 'filesRead', args, { workspace })).rejects.toThrow(/handed is the file a person opened/);
  });

  it('a write that carries the stamp is refused there: the file it names stays as it was', async () => {
    f.capabilities.add('files:write');
    const part = { place: { workspace }, path: file, uploadId: 'u1', offset: 0, data: Buffer.from('overwritten').toString('base64'), total: 11, final: true, expectedEtag: 'any' };
    await expect(call('write', 'filesWriteChunk', part, { workspace, id: file })).rejects.toThrow(/read-only/);
    expect(fs.readFileSync(file, 'utf8')).toBe('outside');
  });
});

describe('a page on the phone, the session on a computer', () => {
  beforeEach(() => { scene.sessionOn = 'there'; });
  const phone = (args: Record<string, unknown>) => callOnComputer({ extensionId: 'reader', extensionName: 'Reader', version: '1.0.0' },
    { id: SESSION, deviceId: 'dev-there', deviceLabel: 'there' }, 'filesRead', args);

  it('reads no outside file: the phone stamps none, and one the page names in its own args is not one', async () => {
    await expect(phone({ ref: { workspace, id: file }, offset: 0, length: 100 })).rejects.toThrow(DENIED);
    await expect(phone({ ref: { workspace, id: file }, offset: 0, length: 100, handed: { workspace, id: file } })).rejects.toThrow(DENIED);
    expect(text(await phone({ ref: { workspace, id: 'in.txt' }, offset: 0, length: 100 }) as never)).toBe('inside');
    // A file of the working copy named by its absolute path is the working copy's: read as its relative path is.
    expect(text(await phone({ ref: { workspace, id: path.join(f.root, 'in.txt') }, offset: 0, length: 100 }) as never)).toBe('inside');
  });
});
