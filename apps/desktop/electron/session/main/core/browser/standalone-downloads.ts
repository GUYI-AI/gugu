import { copyFile, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** The browser connection a download handler listens on; the pipe connection of a standalone Chrome has this shape. */
export type DownloadConnection = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: 'event', listener: (message: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void): unknown;
  once(event: 'closed', listener: () => void): unknown;
};

/** What the person decides about a download, and where a failure is shown. */
export type DownloadSaver = {
  /** Where to save a file with this name; `null` when the person cancels. Asked as soon as the download begins. */
  chooseFile(suggestedFilename: string): Promise<string | null>;
  failed(filename: string, error: Error): void;
};

type Outcome = { state: 'completed' | 'canceled'; filePath?: string };
/** Chrome names downloads by this id; it becomes part of a path, so only its plain form is accepted. */
const GUID = /^[\w-]+$/;
/** How long a cancelled download may take to report back before its leftovers are deleted anyway. */
const CANCEL_GRACE_MS = 3_000;

/**
 * The built-in browser asks where to save a download the moment it begins. A headless Chrome has no dialog and would save
 * into ~/Downloads without asking, so downloads go to a private scratch directory instead, the dialog opens at once while
 * Chrome keeps downloading, and the finished file is moved to the chosen place. Cancelling stops the download and deletes
 * what it wrote. The scratch directory goes away with the browser.
 */
export async function manageDownloads(connection: DownloadConnection, saver: DownloadSaver, scratchRoot: string): Promise<void> {
  const scratch = await mkdtemp(path.join(scratchRoot, 'downloads-'));
  const waiting = new Map<string, (outcome: Outcome) => void>();
  await connection.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: scratch, eventsEnabled: true });

  const leftovers = async (guid: string) => {
    const names = await readdir(scratch).catch(() => [] as string[]);
    await Promise.all(names.filter(name => name.startsWith(guid)).map(name => rm(path.join(scratch, name), { recursive: true, force: true })));
  };

  const handle = async (guid: string, suggestedFilename: string) => {
    const name = path.basename(suggestedFilename.replaceAll('\\', '/')) || 'download';
    // Registered before the dialog opens: the download may well finish while the person is still choosing.
    const finished = new Promise<Outcome>(resolve => waiting.set(guid, resolve));
    try {
      const destination = await saver.chooseFile(name);
      if (destination === null) {
        await connection.send('Browser.cancelDownload', { guid }).catch(() => undefined);
        await Promise.race([finished, new Promise(resolve => setTimeout(resolve, CANCEL_GRACE_MS).unref())]);
        return;
      }
      const outcome = await finished;
      if (outcome.state !== 'completed') throw new Error('The download did not finish');
      await mkdir(path.dirname(destination), { recursive: true });
      const from = outcome.filePath ?? path.join(scratch, guid);
      // Another volume cannot be renamed into; copy, and the scratch copy is deleted below.
      await rename(from, destination).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        return copyFile(from, destination);
      });
    } catch (error) {
      await connection.send('Browser.cancelDownload', { guid }).catch(() => undefined);
      saver.failed(name, error instanceof Error ? error : new Error(String(error)));
    } finally {
      waiting.delete(guid);
      await leftovers(guid);
    }
  };

  connection.on('event', message => {
    if (message.sessionId) return; // Download events belong to the browser, never to one page's session.
    const params: { guid?: unknown; suggestedFilename?: unknown; state?: unknown; filePath?: unknown } = message.params ?? {};
    const { guid } = params;
    if (typeof guid !== 'string' || !GUID.test(guid)) return;
    if (message.method === 'Browser.downloadWillBegin') {
      void handle(guid, typeof params.suggestedFilename === 'string' ? params.suggestedFilename : '');
    } else if (message.method === 'Browser.downloadProgress') {
      const { state, filePath } = params;
      if (state === 'completed' || state === 'canceled') waiting.get(guid)?.({ state, filePath: typeof filePath === 'string' ? filePath : undefined });
    }
  });
  connection.once('closed', () => {
    for (const resolve of waiting.values()) resolve({ state: 'canceled' });
    void rm(scratch, { recursive: true, force: true });
  });
}
