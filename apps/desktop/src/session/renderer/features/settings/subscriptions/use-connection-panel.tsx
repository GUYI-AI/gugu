import { useCallback, useState } from 'react';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { useExternalMenuTrigger } from '@/components/ui/externalMenuTrigger';
import { SubscriptionConnections } from './SubscriptionConnections';

/**
 * Keep the task mounted: the connection menu overlays its caller and never changes its route.
 * Its buttons are in several places, some in the Solid transcript rows, so it follows the Trigger rule through
 * `useExternalMenuTrigger`: pressing the same button again closes it, and the menu stays attached to that button.
 */
export function useConnectionPanel() {
  const [signIn, setSignIn] = useState<{ agent: AgentPayload; machine: string | null } | null>(null);
  const trigger = useExternalMenuTrigger<{ agent: AgentPayload; machine: string | null }>();
  const { press } = trigger;
  const show = useCallback((agent: AgentPayload, machine: string | null, anchor?: HTMLElement) => {
    const origin = anchor ?? document.activeElement;
    if (!(origin instanceof HTMLElement)) throw new Error('Connection configuration requires a focused origin');
    press(origin, { agent, machine });
  }, [press]);
  const request = trigger.last;
  const menu = request && <SubscriptionConnections
    key={`${request.value.machine ?? 'local'}:${request.value.agent.id}`}
    agent={request.value.agent} machine={request.value.machine} trigger={null}
    open={request.open} onOpenChange={trigger.onOpenChange} anchor={request.anchor}
  />;
  const login = signIn && <SubscriptionConnections key={`sign-in:${signIn.machine ?? 'local'}:${signIn.agent.id}`}
    agent={signIn.agent} machine={signIn.machine} trigger={null} signInRequested={signIn} />;
  return {
    show,
    signIn: useCallback((agent: AgentPayload, machine: string | null) => setSignIn({ agent, machine }), []),
    // The last request stays mounted after the menu closes, while its add/login dialog finishes.
    panel: menu && login ? <>{menu}{login}</> : menu || login,
  };
}
