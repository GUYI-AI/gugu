import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserPageFeedback } from '@shared/browser-page-feedback';
import { TaskPageCapture } from '../../../../apps/desktop/electron/server/server-task-page-capture';
import type { TaskPageScreenFrame } from '../../../../apps/desktop/electron/server/server-task-browser';

afterEach(() => vi.useRealTimers());

function fixture() {
  const model = new BrowserPageFeedback(() => 'zh-CN'), frames: TaskPageScreenFrame[] = [];
  const state = { loader: 'one', width: 800, height: 600, scale: 1, live: true };
  let duringCapture: () => Promise<void> = async () => {};
  const send = vi.fn(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: state.loader } } };
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: {
      clientWidth: state.width, clientHeight: state.height, pageX: 0, pageY: 0, scale: state.scale,
    } };
    if (method !== 'Page.captureScreenshot') throw new Error(`Unexpected command ${method}`);
    await duringCapture();
    return { data: '/9g=' };
  });
  const failed = vi.fn();
  const capture = new TaskPageCapture(send, model, () => state.live, failed);
  return { model, state, frames, send, failed, capture, publish: (frame: TaskPageScreenFrame) => frames.push(frame),
    during(work: () => Promise<void>) { duringCapture = work; } };
}

describe('requested task page pictures', () => {
  it('refreshes confirmed feedback on a static page without a frame clock or screencast', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.capture.start(f.publish);
      f.model.dispatched('Input.dispatchMouseEvent', { type: 'mousePressed', x: 24, y: 36 }, Promise.resolve());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(f.frames.at(-1)?.feedback).toMatchObject({ cursor: { x: 24, y: 36, click: expect.any(String) } });
      expect(f.send.mock.calls.some(([method]) => /Screencast|Performance/.test(method))).toBe(false);
      const call = new AbortController(); f.model.followCall(call.signal);
      await vi.advanceTimersByTimeAsync(250);
      expect(f.frames.at(-1)?.feedback?.action?.phase).toBe('running');
      call.abort(); await vi.advanceTimersByTimeAsync(250);
      expect(f.frames.at(-1)?.feedback?.action).toBeUndefined();
    } finally { f.capture.stop(); }
  });

  it.each(['loader', 'width'] as const)('discards a picture whose %s changes during capture', async field => {
    const f = fixture();
    f.during(async () => { if (field === 'loader') f.state.loader = 'two'; else f.state.width = 640; });
    try { await f.capture.start(f.publish); expect(f.frames).toHaveLength(0); }
    finally { f.capture.stop(); }
  });

  it('does not decorate an image when an input completes during capture', async () => {
    const f = fixture();
    f.during(async () => { f.model.dispatched('Input.dispatchMouseEvent', { x: 50, y: 60 }, Promise.resolve()); await Promise.resolve(); });
    try { await f.capture.start(f.publish); expect(f.frames[0]?.feedback).toBeUndefined(); }
    finally { f.capture.stop(); }
  });

  it('serializes capture across restart and suppresses the old generation', async () => {
    const f = fixture(), pending = Promise.withResolvers<void>();
    f.during(() => pending.promise);
    const old = f.capture.start(f.publish);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.any(Object)));
    f.capture.stop();
    const next = f.capture.start(f.publish);
    pending.resolve();
    try {
      await Promise.all([old, next]);
      expect(f.frames).toHaveLength(1);
      expect(f.send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')).toHaveLength(2);
    } finally { f.capture.stop(); }
  });

  it('omits ambiguous scaled pointers and reports capture failure without stale publication', async () => {
    const f = fixture();
    f.model.dispatched('Input.dispatchMouseEvent', { x: 50, y: 60 }, Promise.resolve()); await Promise.resolve();
    f.state.scale = 2;
    try {
      await f.capture.start(f.publish);
      expect(f.frames[0]?.feedback).not.toHaveProperty('cursor');
      f.during(async () => { throw new Error('Capture failed'); });
      await f.capture.start(f.publish);
      expect(f.frames).toHaveLength(1); expect(f.failed).toHaveBeenCalledOnce();
    } finally { f.capture.stop(); }
  });
});
