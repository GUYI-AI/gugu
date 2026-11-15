import { describe, expect, it } from 'vitest';
import { agentRunContextSchema } from '../../agent-run-context';
import { createHarnessConnectionSchema, harnessConnectionTargetSchema } from '../../../workspace-server/agent-config/connections';
import {
  apiKeyConnectionCapability,
  apiKeyConnectionDescriptorSchema,
  apiKeyConnectionEndpoint,
  apiKeyConnectionInjectsModel,
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

  it('a model-injection connection names its own address and model; it needs no launch behavior', () => {
    const injected = { kind: 'supported', delivery: 'model-injection', endpoint: 'required', model: 'required', protocol: 'openai-responses', evidence: 'x' } as const;
    expect(apiKeyConnectionDescriptorSchema.safeParse(injected).success).toBe(true);
    expect(apiKeyConnectionDescriptorSchema.safeParse({ ...injected, endpoint: 'optional' }).success).toBe(false);
    expect(apiKeyConnectionDescriptorSchema.safeParse({ ...injected, model: 'none' }).success).toBe(false);
    expect(apiKeyConnectionInjectsModel(injected)).toBe(true);
    expect(apiKeyConnectionInjectsModel({ ...injected, delivery: 'env' })).toBe(false);
    expect(apiKeyConnectionInjectsModel({ kind: 'none' })).toBe(false);
    expect(apiKeyConnectionCapability.requiresBehavior?.(injected)).toBe(false);
    expect(apiKeyConnectionCapability.requiresBehavior?.({ ...injected, delivery: undefined })).toBe(true);
  });

  it('enforces the declared fields: required ones present, absent ones not sent', () => {
    const qwen = { endpoint: 'required', model: 'required' } as const;
    expect(apiKeyConnectionInputError(qwen, { endpoint: 'https://g.example/v1', models: ['m'] })).toBeNull();
    expect(apiKeyConnectionInputError(qwen, { endpoint: 'https://g.example/v1', models: ['m', 'n'] })).toBeNull();
    expect(apiKeyConnectionInputError(qwen, { models: ['m'] })).toMatch(/address is required/);
    expect(apiKeyConnectionInputError(qwen, { endpoint: 'https://g.example/v1' })).toMatch(/at least one model/);
    expect(apiKeyConnectionInputError(qwen, { endpoint: 'https://g.example/v1', models: [] })).toMatch(/at least one model/);
    const official = { endpoint: 'none', model: 'none' } as const;
    expect(apiKeyConnectionInputError(official, {})).toBeNull();
    expect(apiKeyConnectionInputError(official, { endpoint: 'https://g.example' })).toMatch(/official API key/);
    expect(apiKeyConnectionInputError(official, { models: ['m'] })).toMatch(/no model/);
    const optional = { endpoint: 'optional', model: 'none' } as const;
    expect(apiKeyConnectionInputError(optional, {})).toBeNull();
    expect(apiKeyConnectionInputError(optional, { endpoint: 'https://g.example' })).toBeNull();
  });

  it('an unchanged official address is stored as no address, so it reads as official everywhere', () => {
    const pi = { officialEndpoint: 'https://api.openai.com/v1' };
    expect(apiKeyConnectionEndpoint(pi, 'https://api.openai.com/v1')).toBeUndefined();
    expect(apiKeyConnectionEndpoint(pi, 'https://API.openai.com/v1/')).toBeUndefined();
    expect(apiKeyConnectionEndpoint(pi, '  ')).toBeUndefined();
    expect(apiKeyConnectionEndpoint(pi, 'https://relay.example/v1/')).toBe('https://relay.example/v1');
    expect(apiKeyConnectionEndpoint({}, 'https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
  });

  it('a prefilled official address and the detected protocols are part of the declaration', () => {
    const base = { kind: 'supported', endpoint: 'required', model: 'required', protocol: 'openai-responses', evidence: 'x' } as const;
    expect(apiKeyConnectionDescriptorSchema.safeParse({ ...base, officialEndpoint: 'https://api.openai.com/v1', protocols: ['openai-responses', 'openai-chat-completions'] }).success).toBe(true);
    // 探不出来时用的那一种必须是讲得了的之一;没有地址格就没有地址可预填。
    expect(apiKeyConnectionDescriptorSchema.safeParse({ ...base, protocols: ['openai-chat-completions'] }).success).toBe(false);
    expect(apiKeyConnectionDescriptorSchema.safeParse({ kind: 'supported', endpoint: 'none', model: 'none', officialEndpoint: 'https://x.example', evidence: 'x' }).success).toBe(false);
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
  it('accepts any provider id (the host decides which ones have connections) and optional models', () => {
    expect(harnessConnectionTargetSchema.safeParse({ providerId: 'qwen', connectionId: 'c1' }).success).toBe(true);
    expect(harnessConnectionTargetSchema.safeParse({ providerId: '', connectionId: 'c1' }).success).toBe(false);
    expect(
      createHarnessConnectionSchema.safeParse({ providerId: 'qwen', kind: 'api-key', apiKey: 'k', endpoint: 'https://g.example/v1', models: ['qwen3', 'qwen3-max'] }).success
    ).toBe(true);
    // 点名了就至少一个;重复的并成一个。
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'qwen', kind: 'api-key', apiKey: 'k', models: [] }).success).toBe(false);
    expect(createHarnessConnectionSchema.parse({ providerId: 'qwen', kind: 'api-key', apiKey: 'k', models: ['a', 'a', 'b'] }).models).toEqual(['a', 'b']);
  });

  it('an account connection carries no key, address or model', () => {
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'claude', kind: 'account' }).success).toBe(true);
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'claude', kind: 'account', models: ['m'] }).success).toBe(false);
    expect(createHarnessConnectionSchema.safeParse({ providerId: 'qwen', kind: 'api-key', models: ['m'] }).success).toBe(false);
  });
});
