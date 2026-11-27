import { afterEach, expect, it } from 'vitest';
import { forgetReviewRoute, reviewDivert, reviewRouteAlias } from './review-routes';

const target = { connectionId: '00000000-0000-4000-8000-000000000002', modelId: 'claude-haiku-5-5' };
const body = (model: string) => Buffer.from(JSON.stringify({ model, max_tokens: 64, messages: [] }));
const resolve = async (connectionId: string) => connectionId === target.connectionId ? { endpoint: 'https://relay.example/', apiKey: 'fixture-relay-key' } : null;
afterEach(() => { forgetReviewRoute('session-a'); forgetReviewRoute('session-b'); });

it('diverts only this session\'s reviewer alias, to the reviewer connection with the real model id', async () => {
  const alias = reviewRouteAlias('session-a', target);
  expect(alias).toMatch(/^gugu-reviewer-[0-9a-f]{16}$/);
  const divert = await reviewDivert('session-a', '/v1/messages', '?beta=true', resolve)(body(alias));
  expect(divert?.upstream().toString()).toBe('https://relay.example/v1/messages?beta=true');
  expect(await divert?.credential()).toBe('fixture-relay-key');
  expect(divert?.credentialHeaders?.('fixture-relay-key')).toEqual({ authorization: 'Bearer fixture-relay-key', 'x-api-key': 'fixture-relay-key' });
  expect(JSON.parse(divert!.body!(body(alias)).toString())).toEqual({ model: 'claude-haiku-5-5', max_tokens: 64, messages: [] });
});

it('leaves the session\'s own models, other sessions and unparsable bodies on the session upstream', async () => {
  const alias = reviewRouteAlias('session-a', target);
  expect(await reviewDivert('session-a', '/v1/messages', '', resolve)(body('glm-5'))).toBeNull();
  expect(await reviewDivert('session-b', '/v1/messages', '', resolve)(body(alias))).toBeNull();
  expect(await reviewDivert(undefined, '/v1/messages', '', resolve)(body(alias))).toBeNull();
  expect(await reviewDivert('session-a', '/v1/messages', '', resolve)(Buffer.from('not json'))).toBeNull();
  forgetReviewRoute('session-a');
  expect(await reviewDivert('session-a', '/v1/messages', '', resolve)(body(alias))).toBeNull();
});

it('fails the reviewer request loudly when its connection is gone, instead of sending it to the session model', async () => {
  const alias = reviewRouteAlias('session-a', { ...target, connectionId: '00000000-0000-4000-8000-000000000009' });
  await expect(reviewDivert('session-a', '/v1/messages', '', resolve)(body(alias))).rejects.toThrow(/unavailable/);
});
