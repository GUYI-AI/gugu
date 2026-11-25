import type { HostIpc, HostIpcMain } from '../lib/host-ipc';

let lastActivity = performance.now();
let cancellation: Int32Array | undefined;
let activeRequests = 0;

export const databaseRequestsActive = () => activeRequests > 0;

/** Called before host requests/events are admitted, including remote requests. */
export function noteDatabaseActivity(): void {
  lastActivity = performance.now();
  if (cancellation) Atomics.store(cancellation, 0, 1);
}

export function databaseQuietFor(milliseconds: number): boolean {
  return performance.now() - lastActivity >= milliseconds;
}

export function beginDatabaseMaintenance() {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  cancellation = control;
  return {
    buffer: control.buffer as SharedArrayBuffer,
    cancel: () => { Atomics.store(control, 0, 1); },
    release: () => { if (cancellation === control) cancellation = undefined; },
  };
}

/** Signal before admitting a request, preserving removable event listeners. */
export function withDatabaseActivity(host: HostIpc): HostIpc {
  type Listener = Parameters<HostIpcMain['on']>[1];
  const wrapped = new WeakMap<Listener, Listener>();
  return { ...host, ipcMain: {
    handle(channel, listener) {
      host.ipcMain.handle(channel, (event, ...args) => {
        noteDatabaseActivity();
        activeRequests += 1;
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
        wrapper = (event, ...args) => { noteDatabaseActivity(); return listener(event, ...args); };
        wrapped.set(listener, wrapper);
      }
      host.ipcMain.on(channel, wrapper);
    },
    removeHandler: host.ipcMain.removeHandler.bind(host.ipcMain),
    removeListener(channel, listener) { host.ipcMain.removeListener(channel, wrapped.get(listener) ?? listener); },
  } };
}
