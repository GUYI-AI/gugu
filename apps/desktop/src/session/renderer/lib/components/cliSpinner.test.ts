// @vitest-environment jsdom
//
// spec agent-status「附属态」:后台运行中(回合已结束、只剩后台 / 定时)= 同一枚转圈字形、动画停。
// 转动在 CSS 里(共用的 .gg-running-glyph 字形条,合成器位移):这里判组件的契约 —— 永远不起计时器;整套字形都在条上;
// 看不见(窗口、文档、所在页面、视口)就把暂停开关打开,看得见就关上。真实的动画时钟在浏览器用例里判
// (tests/browser/running-motion.test.tsx)。
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLISpinner } from './cliSpinner';
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility';
import { SurfaceShownContext } from '@/lib/retainedSurface';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(): void {
  act(() => root.render(createElement(CLISpinner)));
}
const spinner = () => container.querySelector<HTMLElement>('.gg-running-glyph');
const paused = () => spinner()?.hasAttribute('data-animation-off') ?? false;

describe('CLISpinner', () => {
  it('draws the shared glyph strip (frames are its generated content, no DOM text) and no timer ever runs', () => {
    render();
    const strip = container.querySelector('.gg-running-glyph__strip')!;
    expect(strip).not.toBeNull();
    expect(container.textContent).toBe('');
    act(() => vi.advanceTimersByTime(5000));
    expect(vi.getTimerCount()).toBe(0);
    expect(paused()).toBe(false);
  });

  it('native minimize pauses it and restore resumes it, including on remount', () => {
    render();
    act(() => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })));
    expect(paused()).toBe(true);
    render();
    expect(paused()).toBe(true);
    act(() => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true })));
    expect(paused()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses on document visibility changes and resumes when visible', () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    render();
    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(paused()).toBe(true);
    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(paused()).toBe(false);
  });

  it('uses the retained page visibility and resumes on return', () => {
    const page = (shown: boolean) => createElement(SurfaceShownContext.Provider, { value: shown }, createElement(CLISpinner));
    act(() => root.render(page(true)));
    expect(paused()).toBe(false);
    act(() => root.render(page(false)));
    expect(paused()).toBe(true);
    act(() => root.render(page(true)));
    expect(paused()).toBe(false);
  });

  it('uses the shared viewport observer to pause and restart offscreen motion', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const doc = iframe.contentDocument!;
    vi.spyOn(doc, 'hidden', 'get').mockReturnValue(false);
    doc.body.append(container);
    let intersect!: IntersectionObserverCallback;
    const unobserve = vi.fn();
    Object.defineProperty(doc.defaultView!, 'IntersectionObserver', { configurable: true, value: class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback; }
      observe() {}
      unobserve = unobserve;
    } });
    render();
    const target = spinner()!;
    const visible = (isIntersecting: boolean) => act(() => intersect([{ target, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    visible(false);
    expect(paused()).toBe(true);
    visible(true);
    expect(paused()).toBe(false);
    act(() => root.render(null));
    expect(unobserve).toHaveBeenCalledWith(target);
    document.body.append(container);
    iframe.remove();
  });

  it('follows its portal document rather than the hidden main document', () => {
    act(() => window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })));
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const portalDoc = iframe.contentDocument!;
    vi.spyOn(portalDoc, 'hidden', 'get').mockReturnValue(false);
    portalDoc.body.append(container);
    render();
    expect(paused()).toBe(false);
    act(() => portalDoc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false })));
    expect(paused()).toBe(true);
    act(() => portalDoc.defaultView!.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true })));
    expect(paused()).toBe(false);
    act(() => root.render(null));
    document.body.append(container);
    iframe.remove();
  });

  it('the glyph keeps the ink colour (owner 2026-09-26)', () => {
    render();
    const glyph = container.firstElementChild as HTMLElement;
    expect(glyph.className).toContain('text-foreground/60');
    expect(glyph.className).not.toContain('agent-tone');
  });
});
