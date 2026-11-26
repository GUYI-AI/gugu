/**
 * Owner 11-21: the Usage popover (sidebar avatar) does not close on a click on the rail; the same for a click on the title
 * bar. Both are window drag regions, and a drag region swallows the press at the OS (Electron: "Draggable areas ignore all
 * pointer events"), so Base UI never sees the outside press. CDP clicks skip that hit test, so this is judged on the computed
 * `-webkit-app-region` in real Chromium with the real CSS: while a popover or menu of either ui kit is open nothing in the
 * window is a drag region; closed, the bands drag again; an open modal sheet leaves them dragging (@@@window-layer).
 * (@@@open-layer-no-drag: each kit draws `OpenLayer` in its positioner, which marks `<html>`.)
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import '@/styles/tokens.css';
import '@renderer/index.css';

const { Popover } = await import('@/components/ui/Popover');
const { Menu, MenuItem } = await import('@/components/ui/Menu');
const SessionPopover = await import('@renderer/lib/ui/popover');
const SessionSheet = await import('@renderer/lib/ui/sheet');

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); });
afterEach(() => harness.cleanup());

/** The open layer's own surface: what the test marked, or the menu Base UI drew. */
const LAYER = '.probe-layer, [role=menu]';
const region = (selector: string) => getComputedStyle(document.querySelector(selector)!).getPropertyValue('-webkit-app-region');

/** A rail and a title band as the shell draws them (both drag regions), beside the layer under test. */
async function withBands(layer: ReactNode) {
  await renderWithAppProviders(harness, createElement(Fragment, null,
    createElement('nav', { 'data-band': 'rail', className: 'window-drag-region', style: { width: 60, height: 400 } }),
    createElement('div', { 'data-band': 'title', className: '[-webkit-app-region:drag]', style: { height: 40 } }),
    createElement('div', { 'data-band': 'plain', style: { height: 40 } }),
    layer))
  await new Promise((resolve) => requestAnimationFrame(resolve))
}

describe('an open popover or menu turns the window drag regions off, so a click there reaches it', () => {
  it.each([
    ['ui/Popover', () => createElement(Popover.Root, { open: true }, createElement(Popover.Portal, null,
      createElement(Popover.Positioner, null, createElement(Popover.Popup, { className: 'probe-layer' }, 'usage'))))],
    ['ui/Menu', () => createElement(Menu, { x: 120, y: 240, ariaLabel: 'more', children: createElement(MenuItem, null, 'copy') })],
    ['session ui popover', () => createElement(SessionPopover.Popover, { open: true },
      createElement(SessionPopover.PopoverContent, { className: 'probe-layer' }, 'project'))],
  ])('%s: open, nothing drags; closed, the rail and the title band drag again', async (_, layer) => {
    await withBands(layer())
    expect(document.querySelector(LAYER)).not.toBeNull()
    expect([region('[data-band=rail]'), region('[data-band=title]')]).toEqual(['no-drag', 'no-drag'])
    expect(region(LAYER)).not.toBe('drag')
    // Only the drag regions are restyled, ❌ every element under <html> (a whole-page style recalculation per open and close).
    expect(region('[data-band=plain]')).not.toBe('no-drag')
    harness.cleanup()
    harness = createReactHarness()
    await withBands(null)
    expect([region('[data-band=rail]'), region('[data-band=title]')]).toEqual(['drag', 'drag'])
  })

  it('[control] an open modal sheet keeps the bands dragging: it has its own backdrop', async () => {
    await withBands(createElement(SessionSheet.Sheet, { open: true }, createElement(SessionSheet.SheetContent, { className: 'probe-layer' }, 'sheet')))
    expect(document.querySelector(LAYER)).not.toBeNull()
    expect([region('[data-band=rail]'), region('[data-band=title]')]).toEqual(['drag', 'drag'])
  })
})
