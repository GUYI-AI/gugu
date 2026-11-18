import { expect, it } from 'vitest';
import { apiKeyConnectionEndpoint } from './api-key-connection';
import { createHarnessConnectionSchema } from '../../../workspace-server/agent-config/connections';

it('retains endpoint-only normalization for reading released metadata', () => {
  expect(apiKeyConnectionEndpoint({ officialEndpoint: 'https://api.openai.com/v1' }, 'https://api.openai.com/v1/')).toBeUndefined();
  expect(apiKeyConnectionEndpoint({ officialEndpoint: 'https://api.openai.com/v1' }, 'https://relay.test/v1/')).toBe('https://relay.test/v1');
});
it('account connections expose no endpoint or models form', () => {
  expect(createHarnessConnectionSchema.safeParse({ providerId: 'claude', kind: 'api-key', apiKey: 'k' }).success).toBe(false);
  expect(createHarnessConnectionSchema.parse({ providerId: 'kilocode', kind: 'account', apiKey: 'k', endpoint: 'https://ignored.test', models: ['m'] })).toEqual({ providerId: 'kilocode', kind: 'account', apiKey: 'k' });
});
