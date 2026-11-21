import { parentPort } from 'node:worker_threads';
import { foldRecord, TURNS_PER_MESSAGE, type FoldAck, type FoldReply, type FoldRequest } from './fold';

const port = parentPort;
if (!port) throw new Error('The session timeline fold requires a worker thread');
/** One checkpoint file is written by one fold at a time. */
const writing = new Map<string, Promise<void>>();
/** Per fold, the slice waiting for the main thread to take the one before. */
const acks = new Map<number, () => void>();

port.on('message', (message: { id: number; request: FoldRequest } | FoldAck) => {
  if ('ack' in message) { acks.get(message.id)?.(); return; }
  void fold(message.id, message.request);
});

const taken = (id: number) => new Promise<void>((resolve) => acks.set(id, () => { acks.delete(id); resolve(); }));

async function fold(id: number, request: FoldRequest): Promise<void> {
  const send = (reply: FoldReply) => port!.postMessage(reply);
  let write: () => Promise<void>;
  try {
    const folded = await foldRecord(request);
    write = folded.write;
    const archive = folded.archive;
    if (!archive) {
      send({ id, archive: null });
    } else {
      // The turns go over in slices: one message is deserialized on the main thread in one go.
      const { committed } = archive.parser.transcript;
      let next = taken(id);
      send({ id, head: { ...archive, parser: { ...archive.parser, transcript: { ...archive.parser.transcript, committed: [] } } }, turns: committed.length });
      for (let from = 0; from < committed.length; from += TURNS_PER_MESSAGE) {
        await next;
        next = taken(id);
        send({ id, turns: committed.slice(from, from + TURNS_PER_MESSAGE) });
      }
      acks.delete(id);
    }
  } catch (error) {
    send({ id, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } });
    return;
  }
  const file = request.checkpoint;
  const done = (writing.get(file) ?? Promise.resolve()).then(write).catch((error: unknown) =>
    send({ id, warning: `checkpoint not written: ${error instanceof Error ? error.message : String(error)}` }));
  writing.set(file, done);
  await done;
  if (writing.get(file) === done) writing.delete(file);
}
