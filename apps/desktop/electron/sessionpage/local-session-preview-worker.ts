import { parentPort } from 'node:worker_threads';
import { readBoundedLocalSessionPreview, type LocalPreviewRequest } from './local-session-preview';

const port = parentPort;
if (!port) throw new Error('Local session preview requires a worker thread');
const requests = new Map<number, AbortController>();
let queue = Promise.resolve();
port.on('message', (message: { id: number; request?: LocalPreviewRequest; cancel?: true }) => {
  if (message.cancel) { requests.get(message.id)?.abort(); return; }
  if (!message.request) return;
  const request = message.request, controller = new AbortController();
  requests.set(message.id, controller);
  queue = queue.then(async () => {
    try {
      controller.signal.throwIfAborted();
      const value = await readBoundedLocalSessionPreview(request, controller.signal);
      port.postMessage({ id: message.id, value });
    } catch (error) {
      port.postMessage({ id: message.id, error: { name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error) } });
    } finally { requests.delete(message.id); }
  });
});
