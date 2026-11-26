import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLAUDE_REVIEWER, nativeClaudeReviewEnv, resolveClaudeReviewer, reviewConnectionsOf, reviewerHonouredByAllowlist,
  type ClaudeReviewInput,
} from './auto-review-source';
import {
  autoReviewModelOptions, canSpecifyClaudeReviewModel, cliRefusesAutoMode, isAutoReviewCapable, platformAutoReviewModelOptions,
} from './auto-review-model';

const connectionId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const model = { id: 'anthropic/claude-sonnet-4-6' };
const session = { connectionId, endpoint: 'https://compatible.example/v1', models: [model, { id: 'claude-sonnet-5' }] };
const custom: ClaudeReviewInput = { route: 'custom', mainModel: 'claude-sonnet-5', preference: null, platformModels: [], connections: [], session };
const haiku = { id: DEFAULT_CLAUDE_REVIEWER, displayName: 'Claude Haiku 5.5' };
const platform: ClaudeReviewInput = { route: 'platform', mainModel: 'claude-opus-4-6', preference: null, platformModels: [haiku, { id: 'glm-5' }], connections: [] };
const other = { id: otherId, name: 'Relay', keySaved: true, anthropicEndpoint: 'https://relay.example', models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }] };

describe('the review rule', () => {
  it('lets any non-Claude model run Auto mode, and refuses Claude 4.5 and older', () => {
    expect(cliRefusesAutoMode('glm-5')).toBe(false);
    expect(cliRefusesAutoMode('gpt-5.5')).toBe(false);
    for (const id of ['claude-sonnet-4-5', 'claude-opus-4-5-20251101', 'claude-haiku-4-5', 'claude-3-7-sonnet']) expect(cliRefusesAutoMode(id)).toBe(true);
    expect(cliRefusesAutoMode('claude-sonnet-4-6')).toBe(false);
  });
  it('names as a reviewer only the Claude models the CLI both runs Auto mode on and honours', () => {
    for (const id of ['claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-fable-5-2']) expect(isAutoReviewCapable(id)).toBe(true);
    // The CLI ignores these as CLAUDE_CODE_AUTO_MODE_MODEL and reviews with the main model instead.
    for (const id of ['claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'opus', 'sonnet', 'default']) {
      expect(canSpecifyClaudeReviewModel(id)).toBe(false);
      expect(isAutoReviewCapable(id)).toBe(false);
    }
    for (const id of ['glm-5', 'gpt-5.5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) expect(isAutoReviewCapable(id)).toBe(false);
  });
  it('offers every enabled, unlocked, reviewable Gugu model on the Anthropic wire', () => {
    expect(platformAutoReviewModelOptions([
      haiku, { id: 'claude-sonnet-4-6', protocols: ['anthropic-messages'] }, { id: 'claude-opus-5-5' }, { id: 'glm-5' },
      { id: 'claude-sonnet-5', requiresMembership: true }, { id: 'claude-opus-4-7', enabled: false },
      { id: 'claude-sonnet-4-7', protocols: ['openai-chat-completions'] },
    ])).toEqual([{ modelId: DEFAULT_CLAUDE_REVIEWER, label: 'Claude Haiku 5.5' }, { modelId: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' }]);
  });
  it('offers only reviewable Claude models from an Anthropic-format connection, never GLM or DeepSeek on that wire', () => {
    expect(autoReviewModelOptions([{
      id: otherId, name: 'Relay', credentialRef: 'ref', keySaved: true, preset: null,
      endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://relay.example' }],
      models: [{ id: 'glm-5', label: 'GLM-5' }, { id: 'deepseek-v3.2' }, { id: 'claude-sonnet-4-5' }, { id: 'claude-opus-5-5' }, { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
    }])).toEqual([{ connectionId: otherId, modelId: 'claude-sonnet-4-6', label: 'Sonnet 4.6', source: 'Relay' }]);
  });
});

describe('a Gugu-model session', () => {
  it('keeps Claude 4.6 and later on the platform Haiku by default', () => {
    expect(resolveClaudeReviewer(platform)).toEqual({ ok: true, reviewer: { kind: 'platform', modelId: DEFAULT_CLAUDE_REVIEWER, label: 'Claude Haiku 5.5' } });
    // Including the main models that cannot be named as reviewers themselves.
    expect(resolveClaudeReviewer({ ...platform, mainModel: 'claude-opus-5-5' })).toMatchObject({ ok: true, reviewer: { modelId: DEFAULT_CLAUDE_REVIEWER } });
  });
  it('asks for a reviewer on a non-Claude model, and never reviews it with Haiku unasked', () => {
    expect(resolveClaudeReviewer({ ...platform, mainModel: 'glm-5' })).toEqual({ ok: false, reason: 'noReviewer' });
  });
  it('says Claude 4.5 and older cannot run Auto mode, whatever reviewer is chosen', () => {
    expect(resolveClaudeReviewer({ ...platform, mainModel: 'claude-sonnet-4-5' })).toEqual({ ok: false, reason: 'mainModelUnsupported' });
    expect(resolveClaudeReviewer({ ...platform, mainModel: 'claude-sonnet-4-5', preference: { kind: 'platform', modelId: DEFAULT_CLAUDE_REVIEWER } }))
      .toEqual({ ok: false, reason: 'mainModelUnsupported' });
  });
  it('uses the reviewer the user picked from the catalog', () => {
    const picked = { ...platform, mainModel: 'glm-5', platformModels: [...platform.platformModels, { id: 'claude-sonnet-4-6' }] };
    expect(resolveClaudeReviewer({ ...picked, preference: { kind: 'platform', modelId: 'claude-sonnet-4-6' } }))
      .toEqual({ ok: true, reviewer: { kind: 'platform', modelId: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' } });
  });
  it('turns Auto mode off, rather than reviewing with the main model, when the picked reviewer cannot be honoured', () => {
    // Not in this account's catalog (the CLI would drop it from availableModels and fall back to the main model).
    expect(resolveClaudeReviewer({ ...platform, preference: { kind: 'platform', modelId: 'claude-sonnet-4-6' } }))
      .toEqual({ ok: false, reason: 'preferenceUnavailable' });
    // Listed but locked for this plan, or switched off.
    expect(resolveClaudeReviewer({ ...platform, platformModels: [{ ...haiku, requiresMembership: true }], preference: { kind: 'platform', modelId: haiku.id } }))
      .toEqual({ ok: false, reason: 'preferenceUnavailable' });
    expect(resolveClaudeReviewer({ ...platform, platformModels: [{ ...haiku, enabled: false }] })).toEqual({ ok: false, reason: 'noReviewer' });
    // Models the CLI refuses to name as its reviewer ("safeguards refuse"), even when the catalog lists them.
    for (const modelId of ['claude-opus-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
      expect(resolveClaudeReviewer({ ...platform, platformModels: [...platform.platformModels, { id: modelId }], preference: { kind: 'platform', modelId } }))
        .toEqual({ ok: false, reason: 'preferenceUnavailable' });
    }
  });
  it('can be reviewed by a model on one of the user connections, diverted to it', () => {
    expect(resolveClaudeReviewer({ ...platform, mainModel: 'glm-5', connections: [other], preference: { kind: 'custom', connectionId: otherId, modelId: 'claude-sonnet-4-6' } }))
      .toEqual({ ok: true, reviewer: { kind: 'connection', connectionId: otherId, modelId: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (Relay)', cross: true } });
  });
});

describe('a connection session', () => {
  it('keeps a reviewable main model as its own reviewer by default', () => {
    expect(resolveClaudeReviewer(custom)).toEqual({ ok: true, reviewer: { kind: 'connection', connectionId, modelId: 'claude-sonnet-5', label: 'claude-sonnet-5' } });
  });
  it('defaults an official Anthropic key to Haiku', () => {
    expect(resolveClaudeReviewer({ ...custom, session: { ...session, endpoint: 'https://api.anthropic.com' } }))
      .toMatchObject({ ok: true, reviewer: { modelId: DEFAULT_CLAUDE_REVIEWER } });
  });
  it('does not identify lookalike hosts as the official Anthropic service', () => {
    expect(resolveClaudeReviewer({ ...custom, session: { ...session, endpoint: 'https://api.anthropic.com.example' } }))
      .toMatchObject({ ok: true, reviewer: { modelId: 'claude-sonnet-5' } });
  });
  it('uses a listed same-connection Haiku when the main model cannot be named as the reviewer', () => {
    const opus = { ...custom, mainModel: 'claude-opus-5', session: { ...session, models: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-5-5' }] } };
    expect(resolveClaudeReviewer(opus)).toMatchObject({ ok: true, reviewer: { modelId: 'claude-haiku-5-5', byHaiku: true } });
    expect(resolveClaudeReviewer({ ...opus, session: { ...session, models: [{ id: 'claude-opus-5' }] } })).toEqual({ ok: false, reason: 'noReviewer' });
    expect(resolveClaudeReviewer({ ...custom, mainModel: 'glm-5' })).toEqual({ ok: false, reason: 'noReviewer' });
  });
  it('honours the explicit reviewer on its own connection', () => {
    const own = { id: connectionId, keySaved: true, anthropicEndpoint: session.endpoint, models: [model] };
    expect(resolveClaudeReviewer({ ...custom, mainModel: 'glm-5', connections: [own], preference: { kind: 'custom', connectionId, modelId: model.id } }))
      .toEqual({ ok: true, reviewer: { kind: 'connection', connectionId, modelId: model.id, label: model.id } });
  });
  it('reaches a reviewer on another connection, except through a format converter', () => {
    const preference = { kind: 'custom' as const, connectionId: otherId, modelId: 'claude-sonnet-4-6' };
    expect(resolveClaudeReviewer({ ...custom, mainModel: 'glm-5', connections: [other], preference })).toMatchObject({ ok: true, reviewer: { cross: true } });
    expect(resolveClaudeReviewer({ ...custom, connections: [other], preference, session: { ...session, converted: true } }))
      .toEqual({ ok: false, reason: 'crossReviewerUnroutable' });
    expect(resolveClaudeReviewer({ ...custom, session: { ...session, converted: true } })).toEqual({ ok: false, reason: 'noReviewer' });
  });
  it('turns Auto mode off when the picked reviewer is gone, rather than reviewing with the main model', () => {
    const preference = { kind: 'custom' as const, connectionId: otherId, modelId: 'claude-sonnet-4-6' };
    for (const changed of [{ removed: true }, { keySaved: false }, { anthropicEndpoint: undefined }, { models: [] }]) {
      expect(resolveClaudeReviewer({ ...custom, connections: [{ ...other, ...changed }], preference })).toEqual({ ok: false, reason: 'preferenceUnavailable' });
    }
    expect(resolveClaudeReviewer({ ...custom, connections: [], preference })).toEqual({ ok: false, reason: 'preferenceUnavailable' });
    const refused = { ...other, models: [{ id: 'claude-opus-5-5' }] };
    expect(resolveClaudeReviewer({ ...custom, connections: [refused], preference: { ...preference, modelId: 'claude-opus-5-5' } }))
      .toEqual({ ok: false, reason: 'preferenceUnavailable' });
  });
  it('turns Auto mode off when the picked connection model cannot review, as for Gugu models', () => {
    // GLM or DeepSeek on an Anthropic-format connection: the CLI cannot parse their verdict and would block every action.
    for (const modelId of ['glm-5', 'deepseek-v3.2', 'claude-sonnet-4-5']) {
      const connection = { ...other, models: [{ id: modelId }] };
      for (const input of [custom, platform]) {
        expect(resolveClaudeReviewer({ ...input, connections: [connection], preference: { kind: 'custom', connectionId: otherId, modelId } }))
          .toEqual({ ok: false, reason: 'preferenceUnavailable' });
      }
      const own = { id: connectionId, keySaved: true, anthropicEndpoint: session.endpoint, models: [{ id: modelId }] };
      expect(resolveClaudeReviewer({ ...custom, mainModel: 'glm-5', connections: [own], preference: { kind: 'custom', connectionId, modelId } }))
        .toEqual({ ok: false, reason: 'preferenceUnavailable' });
    }
  });
  it('leaves Gugu reviewers to Gugu-model sessions this release', () => {
    expect(resolveClaudeReviewer({ ...custom, platformModels: [haiku], preference: { kind: 'platform', modelId: haiku.id } }))
      .toEqual({ ok: false, reason: 'platformReviewerNeedsPlatformSession' });
  });
  it('has no reviewer without a main model', () => {
    expect(resolveClaudeReviewer({ ...custom, mainModel: ' ' })).toEqual({ ok: false, reason: 'noReviewer' });
  });
});

describe('connection facts and the user allowlist', () => {
  it('reads the Anthropic endpoint of each saved connection', () => {
    expect(reviewConnectionsOf([{
      id: otherId, name: 'Relay', credentialRef: 'ref', keySaved: true, preset: null,
      endpoints: [{ protocol: 'openai-chat-completions', baseUrl: 'https://relay.example/v1' }, { protocol: 'anthropic-messages', baseUrl: 'https://relay.example' }],
      models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
    }])).toEqual([{ id: otherId, name: 'Relay', removed: undefined, keySaved: true, anthropicEndpoint: 'https://relay.example', models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }] }]);
  });
  it('matches allowlist entries by bare id', () => {
    expect(reviewerHonouredByAllowlist('claude-haiku-5-5', null)).toBe(true);
    expect(reviewerHonouredByAllowlist('claude-haiku-5-5', ['claude-haiku-5-5[1m]'])).toBe(true);
    expect(reviewerHonouredByAllowlist('claude-haiku-5-5', ['claude-opus-4-6'])).toBe(false);
  });
});

describe('a native login', () => {
  it.each([{}, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture' }, { ANTHROPIC_AUTH_TOKEN: 'fixture' }, { ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_BASE_URL: 'https://compatible.example' }])('leaves native subscription/unknown providers on their classifier: %j', env => {
    expect(nativeClaudeReviewEnv(env)).toEqual({});
  });
  it('pins Haiku for the official native API key without carrying the key into the result', () => {
    expect(nativeClaudeReviewEnv({ ANTHROPIC_API_KEY: 'fixture' })).toEqual({ CLAUDE_CODE_AUTO_MODE_MODEL: DEFAULT_CLAUDE_REVIEWER, CLAUDE_CODE_AUTO_MODE_SERVER: '0' });
  });
  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])('uses an explicitly selected model on a native compatible API (%s)', credential => {
    expect(nativeClaudeReviewEnv({ [credential]: 'fixture', ANTHROPIC_BASE_URL: 'https://compatible.example/v1', ANTHROPIC_MODEL: 'claude-sonnet-5' }))
      .toEqual({ CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5', CLAUDE_CODE_AUTO_MODE_SERVER: '0' });
  });
  it('never names a model that cannot review, leaving the CLI on its own classifier', () => {
    for (const model of ['glm-5', 'deepseek-v3.2', 'claude-opus-5-5']) {
      expect(nativeClaudeReviewEnv({ ANTHROPIC_AUTH_TOKEN: 'fixture', ANTHROPIC_BASE_URL: 'https://compatible.example', ANTHROPIC_MODEL: model })).toEqual({});
    }
  });
});
