// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNode, createReactHarness } from '../../../../../../../../tests/support/testHarness';

/**
 * Settings → Sessions opened before its values are read (open-flicker ST1/ST2): the first frame draws placeholders,
 * never the schema defaults dressed as the stored values — and after a restart it draws the stored values at once.
 */
const io = vi.hoisted(() => ({
  meta: null as null | Promise<unknown>,
  catalog: null as null | Promise<unknown>,
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { appSettings: { getWithMeta: () => io.meta, getAll: () => new Promise(() => {}) } },
  rpcOn: () => ({ appSettings: { getWithMeta: () => io.meta } }),
  invokeOnMachine: () => io.catalog,
  events: { on: () => () => {} },
}));

const stored = {
  autoGenerateName: true, autoApproveByDefault: true, autoTrustWorktrees: true, preserveNameCapitalization: true,
  includeIssueContextByDefault: true, titleModel: 'glm-5.3-flash', titleInstructions: '',
};
const meta = { value: stored, defaults: { ...stored, autoGenerateName: false }, overrides: { autoGenerateName: true } };

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback(); });
  harness = createReactHarness();
  io.meta = new Promise(() => {});
  io.catalog = new Promise(() => {});
});
afterEach(() => { harness.cleanup(); });

const switches = () => [...harness.container.querySelectorAll('[role="switch"]')];

describe('Settings → Sessions, first frame', () => {
  it('draws a placeholder where a stored switch goes until it is read, never the switch drawn off', async () => {
    localStorage.clear();
    vi.resetModules();
    const { AutoGenerateSessionNamesRow, AutoApproveByDefaultRow } = await import('./SessionSettingsRows');
    await harness.render(createNode('div', null, createNode(AutoGenerateSessionNamesRow), createNode(AutoApproveByDefaultRow)));
    expect(switches().filter((element) => element.getAttribute('aria-checked') === 'false')).toHaveLength(0);
    expect(harness.container.querySelectorAll('[data-unknown]').length).toBeGreaterThanOrEqual(2);
  });

  it('names the title model by its catalog name or a placeholder, never by its raw id', async () => {
    localStorage.clear();
    vi.resetModules();
    io.meta = Promise.resolve(meta);
    const { SessionTitleModelRow } = await import('./SessionSettingsRows');
    await harness.render(createNode(SessionTitleModelRow));
    await vi.waitFor(() => expect(harness.container.querySelector('[data-unknown]')).not.toBeNull());
    expect(harness.container.textContent).not.toContain('glm-5.3-flash');
  });

  it('after a restart the stored values are on the first frame, before anything is read again', async () => {
    localStorage.clear();
    vi.resetModules();
    io.meta = Promise.resolve(meta);
    const first = await import('./SessionSettingsRows');
    await harness.render(createNode(first.AutoGenerateSessionNamesRow));
    await vi.waitFor(() => expect(switches()[0]?.getAttribute('aria-checked')).toBe('true'));
    harness.cleanup();

    // The next start: nothing answers yet.
    vi.resetModules();
    io.meta = new Promise(() => {});
    harness = createReactHarness();
    const next = await import('./SessionSettingsRows');
    await harness.render(createNode(next.AutoGenerateSessionNamesRow));
    expect(switches()[0]?.getAttribute('aria-checked')).toBe('true');
  });
});
