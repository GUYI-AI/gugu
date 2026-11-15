// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createNode, createReactHarness } from '../../../../../../../../tests/support/testHarness';
import { SettingValue } from './SettingControls';

/**
 * A value whose latest read failed is drawn and said to be the last one read (acceptance 2.3: offline, the pages showed
 * the snapshot's values with no word that they could not be read again).
 */
let harness = createReactHarness();
afterEach(() => { harness.cleanup(); harness = createReactHarness(); });

describe('SettingValue', () => {
  it('draws the value and says the latest read failed', async () => {
    await harness.render(createNode(SettingValue, {
      reading: { state: 'value', value: 'Studio Mac', stale: true, error: new Error('offline') },
      children: (value: unknown) => createNode('span', null, String(value)),
    }));
    expect(harness.container.textContent).toContain('Studio Mac');
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('a value read without failure has no note', async () => {
    await harness.render(createNode(SettingValue, {
      reading: { state: 'value', value: 'Studio Mac', stale: false, error: null },
      children: (value: unknown) => createNode('span', null, String(value)),
    }));
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();
  });
});
