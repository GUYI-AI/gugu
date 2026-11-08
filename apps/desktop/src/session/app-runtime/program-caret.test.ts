import { EXTENSION_API_VERSION } from '@shared/extensions/bridge-protocol';
import { describe, expect, it, vi } from 'vitest';
import { applyAwarenessUpdate, Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { FakeService, fileOpened, loadPage, until } from './fake-file-service';

/**
 * An agent's write, where the people in the file see it: a program (an App's tools, writing as the agent that called them)
 * puts its caret at the end of what it changed. Before it writes it is nobody in the file (F16). Its name and colour are
 * not its own to say: the file service stamps `user` on every presence state from the connection's identity.
 */

type TextFile = {
  readonly text: string;
  insert(index: number, text: string): void;
  delete(index: number, length: number): void;
  edit(old: string, next: string): void;
  readonly saved: boolean;
  close(): void;
};

async function load(program: boolean) {
  vi.resetModules();
  const service = new FakeService();
  service.write('item-1@1', 'one two three');
  const { setSyncPortSource } = await import('./sync-link');
  setSyncPortSource(async () => {
    const port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: unknown) => service.fromPage(message),
    };
    service.toPage = (event) => port.onmessage?.(event);
    return port;
  });
  const { openFile } = await import('./files-entry');
  const opened = fileOpened('text');
  const host = {
    apiVersion: EXTENSION_API_VERSION,
    ...(program ? { program: true } : {}),
    reportError: vi.fn(async (_message: string) => undefined),
    onFilesChanged: () => () => undefined,
    appFiles: { open: vi.fn(async () => structuredClone(opened)), close: vi.fn(async () => undefined) },
    clipboard: { writeText: async () => undefined },
  };
  const file = (await openFile(host as never, host.appFiles.open())) as TextFile;
  await until(() => file.saved && file.text === 'one two three');
  return { service, file };
}

/** The page's presence as the others get it — its awareness frames, in order — and where its caret is in the file now. */
function presence(service: FakeService) {
  const others = new Awareness(new Y.Doc());
  for (const update of service.awareness) applyAwarenessUpdate(others, update, 'service');
  const state = [...others.getStates()].find(([id]) => id !== others.clientID)?.[1] as
    | { cursor?: { anchor: unknown; head: unknown }; user?: unknown }
    | undefined;
  const at = (place: unknown) =>
    Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(place), service.docOf('item-1@1'))?.index;
  return { state, anchor: state?.cursor && at(state.cursor.anchor), head: state?.cursor && at(state.cursor.head) };
}

describe("an agent's caret where it writes", () => {
  it('a program is nobody in the file until it writes; then its caret is at the end of the change, and follows the text', async () => {
    const { service, file } = await load(true);
    expect(presence(service).state).toBeUndefined();

    file.edit('two', 'TWO!');
    await until(() => presence(service).head !== undefined);
    expect(presence(service)).toMatchObject({ anchor: 'one TWO!'.length, head: 'one TWO!'.length });
    // No name or colour of its own: the file service stamps who it is.
    expect(presence(service).state?.user).toBeUndefined();

    // Someone types before it: the caret stays after what the agent wrote.
    service.insertAt('item-1@1', 0, 'zero ');
    await until(() => file.text.startsWith('zero '));
    expect(presence(service).head).toBe('zero one TWO!'.length);

    file.delete(0, 'zero '.length);
    await until(() => presence(service).head === 0);
    file.insert(file.text.length, ' four');
    await until(() => presence(service).head === 'one TWO! three four'.length);
    file.close();
  });

  it('a program that wrote ends its connection once its write is confirmed, so the others see its caret before it goes', async () => {
    const { service, file } = await load(true);
    service.holdAcks = true;
    file.edit('two', 'TWO!');
    file.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The file service sends on presence once per turn: a Close behind the caret would leave only "it left".
    expect(service.keysOf('item-1@1')).toHaveLength(1);
    service.releaseAcks();
    await until(() => service.keysOf('item-1@1').length === 0);
  });

  it("its call ends while it waits (main takes the file back, `unbound`): the Close still waits for the confirmation", async () => {
    const { service, file } = await load(true);
    service.holdAcks = true;
    file.edit('two', 'TWO!');
    file.close();
    service.control({ t: 'revoked', docName: 'item-1@1', reason: 'unbound' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(service.keysOf('item-1@1')).toHaveLength(1);
    service.releaseAcks();
    await until(() => service.keysOf('item-1@1').length === 0);
  });

  it('never confirmed: it closes after 2 s all the same', async () => {
    const { service, file } = await load(true);
    service.holdAcks = true;
    file.edit('two', 'TWO!');
    file.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(service.keysOf('item-1@1')).toHaveLength(1);
    await until(() => service.keysOf('item-1@1').length === 0, 1500);
  });

  it('taken back for good while it waits (out of the group): it closes at once', async () => {
    const { service, file } = await load(true);
    service.holdAcks = true;
    file.edit('two', 'TWO!');
    file.close();
    service.control({ t: 'revoked', docName: 'item-1@1', reason: 'removed-from-group' });
    await until(() => service.keysOf('item-1@1').length === 0, 500);
  });

  it('let go of during a reopen (compaction), having written: after the wait it still leaves a will under the new epoch', async () => {
    const { service, open, host } = await loadPage<TextFile>('text', { program: true });
    const posted: unknown[] = [];
    const fromPage = service.fromPage.bind(service);
    service.fromPage = (message: unknown) => {
      if (!(message instanceof ArrayBuffer)) posted.push(message);
      fromPage(message);
    };
    const file = await open();
    const reopen = host.appFiles.reopen.getMockImplementation()!;
    host.appFiles.reopen.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      service.holdAcks = true;
      return reopen();
    });
    expect(await service.compact('item-1@1', 'item-1@2')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    file.insert(0, 'written during the reopen');
    file.close();
    await until(() => host.appFiles.close.mock.calls.length === 1, 4000);
    const wills = posted.filter((message) => (message as { t?: string })?.t === 'will') as { docName: string }[];
    expect(wills.map((will) => will.docName)).toContain('item-1@2');
  });

  it("a person's page writes no caret of its own: its editor's binding says where the person is", async () => {
    const { service, file } = await load(false);
    file.edit('two', 'TWO!');
    await until(() => file.saved && service.text('item-1@1') === 'one TWO! three');
    expect(presence(service).state?.cursor).toBeUndefined();
    file.close();
  });
});
