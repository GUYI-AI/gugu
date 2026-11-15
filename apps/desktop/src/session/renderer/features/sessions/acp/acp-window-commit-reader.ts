/** Local ownership only. RPC types and projection payloads come from the shared contract. */
export interface AcpWindowCommitReaderPort<Cursor, Page, Resident> {
  read(after: Cursor): Promise<Page>;
  cursor(page: Page): Cursor;
  materialize(page: Page): Promise<Resident>;
  /** Synchronous: the owner checks once, then publishes the resident page atomically. */
  commit(resident: Resident, page: Page): void;
  ack(through: Cursor): Promise<void>;
  /** Must release the host owner and settle its outstanding read. */
  release(): void;
  failed(error: unknown): void;
}

/** One page in flight, with no polling, retry, or source change on failure. */
export function startAcpWindowCommitReader<Cursor, Page, Resident>(
  after: Cursor, port: AcpWindowCommitReaderPort<Cursor, Page, Resident>,
): { close(): void; completed: Promise<void> } {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; // Invalidate before releasing: release can synchronously deliver a late response.
    port.release();
  };
  const completed = (async () => {
    try {
      while (!closed) {
        const page = await port.read(after);
        if (closed) return;
        const through = port.cursor(page);
        const resident = await port.materialize(page);
        if (closed) return;
        port.commit(resident, page);
        if (closed) return; // Publishing may synchronously close or replace the view.
        await port.ack(through);
        if (closed) return;
        after = through;
        // Always read again. A final commit can arrive between this page and its ACK.
        // An empty host queue keeps the unique read waiting rather than making us poll.
      }
    } catch (error) {
      if (closed) return;
      close();
      port.failed(error);
    }
  })();
  return { close, completed };
}
