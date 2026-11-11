import { describe, expect, it } from 'vitest';
import { agentRunContextSchema } from '../../agent-run-context';
import { createHarnessConnectionSchema, harnessConnectionTargetSchema } from '../../../workspace-server/agent-config/connections';
import {
  apiKeyConnectionDescriptorSchema,
  apiKeyConnectionInputError,
  apiKeyConnectionPlan,
  apiKeyConnectionUsage,
} from './api-key-connection';

describe('API key connection declaration (#2507)', () => {
  it('an address field must say which protocol it speaks; an official-key-only one needs none', () => {
    expect(apiKeyConnectionDescriptorSchema.safeParse({ kind: 'supported', endpoint: 'required', model: 'required', evidence: 'x' }).success).toBe(false);
    expect(
      apiKeyConnectionDescriptorSchema.safeParse({ kind: 'supported', endpoint: 'optional', model: 'none', protocol: 'anthropic-messages', evidence: 'x' }).success
    ).toBe(true);
    expect(apiKeyConnectionDescriptorSchema.safeParse({ kind: 'supported', endpoint: 'none', model: 'none', evidence: 'x' }).success).toBe(true);
    expect(apiKeyConnectionDescriptorSchema.safeParse({ kind: 'supported', endpoint: 'none', model: 'none', evidence: '' }).success).toBe(false);
  });

  it('enforces the declared fields: required ones present, absent ones not sent', () => {
    const qwen = { endpoint: 'required', model: 'required' } as const;
    expect(apiKeyConnectionInputError(qwen, { endpoint: 'https://g.example/v1', model: 'm' })).toBeNull();
    expect(apiKeyConnectionInputError(qwen, { model: 'm' })).toMatch(/address is required/);
    expect(apiKeyConnectionInputError(qwen, { endpoint: 'https://g.example/v1' })).toMatch(/model is required/);
    const official = { endpoint: 'none', model: 'none' } as const;
    expect(apiKeyConnectionInputError(official, {})).toBeNull();
    expect(apiKeyConnectionInputError(official, { endpoint: 'https://g.example' })).toMatch(/official API key/);
    expect(apiKeyConnectionInputError(official, { model: 'm' })).toMatch(/no model/);
    const optional = { endpoint: 'optional', model: 'none' } as const;
    expect(apiKeyConnectionInputError(optional, {})).toBeNull();
    expect(apiKeyConnectionInputError(optional, { endpoint: 'https://g.example' })).toBeNull();
  });

  it('the run context carries the selected connection across the worker wire (the readings depend on it)', () => {
    const context = {
      cli: { kind: 'resolved', path: '/opt/qwen' },
      env: {},
      configRootEnv: {},
      pinnedEnv: {},
      extraArgs: [],
      connectionId: 'c1',
      apiKeyConnection: { endpoint: 'https://gateway.example/v1' },
    };
    expect(agentRunContextSchema.parse(context).apiKeyConnection).toEqual({ endpoint: 'https://gateway.example/v1' });
  });

  it('reads as an API key (official) or a custom endpoint (by host only)', () => {
    expect(apiKeyConnectionPlan(undefined)).toEqual({ payer: 'api-key' });
    expect(apiKeyConnectionPlan('https://gateway.example:8443/v1')).toEqual({ payer: 'custom-endpoint', endpoint: 'gateway.example:8443' });
    expect(apiKeyConnectionUsage(undefined)).toMatchObject({ kind: 'unavailable', reason: 'not-reported' });
    expect(apiKeyConnectionUsage('https://gateway.example')).toMatchObject({ kind: 'unavailable', reason: 'custom-endpoint' });
  });
});

describe('connection contract', () => {
  it('accepts any provider id (the host decides which ones have connections) and an optional model', () => {
    expect(harnessConnectionTargetSchema.safeParse({ providerId: 'qwen', connectionId: 'c1' }).success).toBe(true);
    expect(harnessConnectionTargetSchema.safeParse({ providerId: '', connectionId: 'c1' }).success).toBe(false);
    expect(
      createHarnessConnectionSchema.safeParse({ providerId: 'qwen', kind: 'api-key', apiKey: 'k', endpoint: 'https://g.example/v1', model: 'qwen3' }).success
    ).toBe(true);
  });

  it('an account connection carries no key, address or model', () => {
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'claude', kind: 'account' }).success).toBe(true);
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'claude', kind: 'account', model: 'm' }).success).toBe(false);
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'qwen', kind: 'api-key', model: 'm' }).success).toBe(false);
  });
});
