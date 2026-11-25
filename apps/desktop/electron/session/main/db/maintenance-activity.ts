import type { HostIpc, HostIpcMain } from '../lib/host-ipc';

let lastActivity = performance.now();
let maintenance: { flag: Int32Array; released: Promise<void> } | undefined;
let activeRequests = 0;

export const databaseRequestsActive = () => activeRequests > 0;

/** Called before host requests/events are admitted, including remote requests. */
export function noteDatabaseActivity(): Promise<void> | undefined {
  lastActivity = performance.now();
  if (!maintenance) return;
  Atomics.store(maintenance.flag, 0, 1);
  return maintenance.released;
}

export function databaseQuietFor(milliseconds: number): boolean {
  return performance.now() - lastActivity >= milliseconds;
}

export function beginDatabaseMaintenance() {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  maintenance = { flag: control, released };
  return {
    buffer: control.buffer as SharedArrayBuffer,
    cancel: () => { Atomics.store(control, 0, 1); },
    release: () => {
      if (maintenance?.flag === control) maintenance = undefined;
      release();
    },
  };
}

/** Signal before admitting a request, preserving removable event listeners. */
export function withDatabaseActivity(host: HostIpc): HostIpc {
  type Listener = Parameters<HostIpcMain['on']>[1];
  const wrapped = new WeakMap<Listener, Listener>();
  return { ...host, ipcMain: {
    handle(channel, listener) {
      host.ipcMain.handle(channel, (event, ...args) => {
        const released = noteDatabaseActivity();
        activeRequests += 1;
        // Cancel synchronously, then await connection close asynchronously. A
        // request's synchronous SQLite write must never enter busy-wait behind
        // the maintenance statement that was already in flight at admission.
        if (released) return released.then(() => listener(event, ...args)).finally(() => { activeRequests -= 1; });
        try {
          const result = listener(event, ...args);
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
            return Promise.resolve(result).finally(() => { activeRequests -= 1; });
          }
          activeRequests -= 1;
          return result;
        } catch (error) { activeRequests -= 1; throw error; }
      });
    },
    on(channel, listener) {
      let wrapper = wrapped.get(listener);
      if (!wrapper) {
        wrapper = (event, ...args) => {
          const released = noteDatabaseActivity();
          if (!released) return listener(event, ...args);
          // Events retain normal emitter error handling after the barrier.
          void released.then(() => { queueMicrotask(() => listener(event, ...args)); });
        };
        wrapped.set(listener, wrapper);
      }
      host.ipcMain.on(channel, wrapper);
    },
    removeHandler: host.ipcMain.removeHandler.bind(host.ipcMain),
    removeListener(channel, listener) { host.ipcMain.removeListener(channel, wrapped.get(listener) ?? listener); },
  } };
}
