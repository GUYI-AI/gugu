import { describe, expect, it } from 'vitest';
import { ASSISTANT_BINDING_ARGS, pickAssistant } from '@gugu/core/shared/assistantProvision';

describe('account App binding identity', () => {
  it('reads the one live binding returned by the owner-scoped RPC without a provision marker', () => {
    expect(ASSISTANT_BINDING_ARGS).toEqual({ p_app_id: 'gugu-assistant' });
    expect(pickAssistant([{ agent_user_id: 'ordinary-agent', device_id: 'current-device' }]))
      .toEqual({ agentId: 'ordinary-agent', deviceId: 'current-device' });
    expect(pickAssistant([])).toBeNull();
  });
  it.each([null, undefined, {}, [null], [false], ['agent'], [{}],
    [{ agent_user_id: '', device_id: 'host' }], [{ agent_user_id: 'agent', device_id: ' ' }],
    [{ agent_user_id: 'agent', device_id: null }],
    [{ agent_user_id: 'one', device_id: 'host' }, { agent_user_id: 'two', device_id: 'host' }]].map(rows => ({ rows })))(
    'refuses unreadable or ambiguous results instead of treating them as unbound: %j',
    ({ rows }) => {
      expect(() => pickAssistant(rows)).toThrow('Could not verify');
    },
  );
});
