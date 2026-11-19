import { webContents, type TraceConfig } from 'electron';
import { acquireMonitorDebugger } from './debugger-lease';

type CaptureConfig = Pick<TraceConfig, 'included_categories' | 'excluded_categories' | 'memory_dump_config'>;
let tracing = false;

/**
 * Electron 45's contentTracing writes protobuf. CDP's ReportEvents transport still supplies decoded JSON events,
 * including memory-infra dumps. Keep the existing summaries without a converter binary or raw traces on disk.
 * Tracing is browser-wide; the main window provides the transport, not the recording's process scope.
 */
export async function recordTrace<E>(config: CaptureConfig, ms: number, name: string): Promise<E[]> {
  if (tracing) throw new Error('another recording is in progress');
  tracing = true;
  let release: (() => void) | undefined;
  try {
    const contents = webContents.getAllWebContents().find((c) =>
      !c.isDestroyed() && c.getType() === 'window' && c.getURL().startsWith('gugu-app://app/'));
    if (!contents) throw new Error('no main window to record');
    release = acquireMonitorDebugger(contents);
    const transport = contents.debugger;
    const events: E[] = [];
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    // A detach can happen while startRecording or the sampling timer is pending; observe it immediately.
    void completed.catch(() => {});
    let started = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (_event: Electron.Event, method: string, params: { value?: E[]; dataLossOccurred?: boolean }, sessionId?: string) => {
      if (sessionId || !started) return;
      if (method === 'Tracing.dataCollected') {
        if (!Array.isArray(params.value)) fail(new Error(`${name}: invalid trace events`));
        else for (const event of params.value) events.push(event);
      } else if (method === 'Tracing.tracingComplete') {
        finished = true;
        if (params.dataLossOccurred) fail(new Error(`${name}: trace data was lost`));
        else complete();
      }
    };
    const onDetach = () => fail(new Error(`${name}: tracing debugger detached`));
    transport.on('message', onMessage);
    transport.once('detach', onDetach);
    try {
      await transport.sendCommand('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: {
          includedCategories: config.included_categories,
          excludedCategories: config.excluded_categories,
          memoryDumpConfig: config.memory_dump_config,
        },
      });
      started = true;
      await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), completed]);
      if (finished) throw new Error(`${name}: tracing ended before the requested interval`);
      await transport.sendCommand('Tracing.end');
      await completed;
      return events;
    } finally {
      clearTimeout(timer);
      if (started && !finished && !contents.isDestroyed() && transport.isAttached()) {
        await transport.sendCommand('Tracing.end').catch(() => {});
      }
      transport.removeListener('message', onMessage);
      transport.removeListener('detach', onDetach);
    }
  } finally {
    try { release?.(); }
    finally { tracing = false; }
  }
}
