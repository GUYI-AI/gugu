import { describe, expect, it } from 'vitest';
import { BrowserPageFeedback, browserFrameFeedback, browserPageFeedback } from './browser-page-feedback';

describe('Browser Use feedback from real page dispatch', () => {
  it('ends operating when the real program call ends, even while pixels continue and another call stays isolated', () => {
    const model = new BrowserPageFeedback(() => 'zh-CN'), a = new AbortController(), b = new AbortController();
    const stopA = model.followCall(a.signal), stopB = model.followCall(b.signal);
    a.abort(); expect(model.snapshot().action?.phase).toBe('running');
    b.abort(); expect(model.snapshot().action).toMatchObject({ phase: 'done', label: '网页操作已结束' });
    stopA(); stopB();
    model.invalidate(); expect(model.snapshot().action).toBeUndefined();
  });

  it('writes its captions in the host language', async () => {
    const model = new BrowserPageFeedback(() => 'en-US'), call = new AbortController(), native = Promise.withResolvers<unknown>();
    const stop = model.followCall(call.signal);
    expect(model.snapshot().action).toMatchObject({ phase: 'running', label: 'Working in the page' });
    call.abort(); expect(model.snapshot().action).toMatchObject({ phase: 'done', label: 'Finished working in the page' });
    stop();
    const page = new BrowserPageFeedback(() => 'en-US');
    page.dispatched('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, native.promise);
    expect(page.snapshot().action).toMatchObject({ phase: 'running', label: 'Clicking' });
    native.resolve({}); await native.promise;
    expect(page.snapshot().action).toMatchObject({ phase: 'done', label: 'Clicked' });
  });

  it('binds feedback to the actual page object and never to a caller-supplied title', () => {
    const page = {}, other = {};
    expect(browserPageFeedback(page, () => 'zh-CN')).toBe(browserPageFeedback(page, () => 'zh-CN'));
    expect(browserPageFeedback(page, () => 'zh-CN').snapshot().target.id).not.toBe(browserPageFeedback(other, () => 'zh-CN').snapshot().target.id);
  });

  it('shows running only for native work and moves a cursor only after that work succeeds', async () => {
    const model = new BrowserPageFeedback(() => 'zh-CN'), native = Promise.withResolvers<unknown>();
    expect(model.snapshot().action).toBeUndefined();
    model.dispatched('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 10 }, native.promise);
    expect(model.snapshot().action?.phase).toBe('running'); expect(model.snapshot().cursor).toBeUndefined();
    native.resolve({}); await native.promise;
    expect(model.snapshot()).toMatchObject({ cursor: { x: 20, y: 10 }, action: { phase: 'done' } });
  });

  it('drops ambiguous child-frame coordinates and late completions after a target changes', async () => {
    const model = new BrowserPageFeedback(() => 'zh-CN'), native = Promise.withResolvers<unknown>();
    model.dispatched('Input.dispatchMouseEvent', { x: 20, y: 10 }, native.promise);
    model.invalidate(); native.resolve({}); await native.promise;
    expect(model.snapshot().cursor).toBeUndefined(); expect(model.snapshot().action).toBeUndefined();
    model.dispatched('Input.dispatchMouseEvent', { x: 20, y: 10 }, Promise.resolve(), true); await Promise.resolve();
    expect(model.snapshot().cursor).toBeUndefined();
  });

  it('does not let a late old native result replace a newer cursor or report an unknown result as failed', async () => {
    const model = new BrowserPageFeedback(() => 'zh-CN'), old = Promise.withResolvers<unknown>();
    model.dispatched('Input.dispatchMouseEvent', { x: 10, y: 10 }, old.promise);
    model.dispatched('Input.dispatchMouseEvent', { x: 20, y: 20 }, Promise.resolve()); await Promise.resolve();
    old.resolve({}); await old.promise;
    expect(model.snapshot().cursor).toMatchObject({ x: 20, y: 20 });
    model.dispatched('Input.dispatchMouseEvent', { x: 30, y: 30 }, Promise.reject(new Error('Unknown outcome'))); await Promise.resolve();
    expect(model.snapshot().cursor).toBeUndefined(); expect(model.snapshot().action).toBeUndefined();
  });

  it('decorates only a stable captured target and keeps pointer bounds in the frame input space', async () => {
    const model = new BrowserPageFeedback(() => 'zh-CN');
    const before = model.snapshot(); model.dispatched('Input.insertText', {}, Promise.resolve());
    expect(browserFrameFeedback(before, model.snapshot(), 40, 30)).toBeUndefined(); await Promise.resolve();
    model.dispatched('Input.dispatchMouseEvent', { x: 40, y: 5 }, Promise.resolve()); await Promise.resolve();
    const stable = model.snapshot();
    expect(browserFrameFeedback(stable, stable, 40, 30)).not.toHaveProperty('cursor');
    expect(browserFrameFeedback(stable, stable, 50, 30)).toMatchObject({ cursor: { x: 40, y: 5 } });
  });

  it('keeps presentation listener errors out of the native input result', async () => {
    const model = new BrowserPageFeedback(() => 'zh-CN'); model.subscribe(() => { throw new Error('Display failed'); });
    expect(() => model.dispatched('Input.insertText', {}, Promise.resolve())).not.toThrow(); await Promise.resolve();
    expect(model.snapshot().action?.phase).toBe('done');
  });
});
