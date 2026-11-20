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

export async function manageDownloads(_connection: DownloadConnection, _saver: DownloadSaver, _scratchRoot: string): Promise<void> {
  // Not implemented yet.
}
