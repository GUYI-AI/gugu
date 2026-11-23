import { describe, expect, it } from 'vitest';
import type { CustomModelConnection } from '@gugu/session-core/models/custom-model';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { customComposerOptions } from './custom-model-options';
import { withOwnRecords } from './use-composer-model-options';

const record = (id: string, baseUrl: string): CustomModelConnection => ({
  id, name: id, credentialRef: id, keySaved: true, preset: null, endpoints: [{ protocol: 'openai-chat-completions', baseUrl }], models: [{ id: 'flash' }],
});
const agent = { id: 'claude', name: 'Claude Code', capabilities: { modelProtocols: ['openai-chat-completions' as const] } };

// A task on another machine still lists the custom models saved here: shown, not selectable, and the row says why.
describe('custom models on another machine', () => {
  it('lists this machine\'s records the task machine lacks, without a key there', () => {
    const records = withOwnRecords([record('remote', 'https://a.example/v1')], [record('local', 'https://api.deepseek.com'), record('same', 'https://a.example/v1')]);
    expect(records.map(({ id, keySaved }) => [id, keySaved])).toEqual([['remote', true], ['local', false]]);
    const options = customComposerOptions(records, agent, 'dpro', translateSessionMessage);
    const here = Object.entries(options).find(([id]) => id.includes('local'))?.[1];
    expect(here).toMatchObject({ disabled: true, disabledReason: translateSessionMessage('customModels.missingKey', { device: 'dpro' }) });
    expect(Object.entries(options).find(([id]) => id.includes('remote'))?.[1].disabled).toBeUndefined();
  });
});
