import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { isSubscribeFailure, subscribeStatusName } from '@gugu/core/cloud/deviceRpcProtocol';
import { log } from '@main/lib/logger';
import { createElectronRealtimeClient } from '../../../../supabase';
import { subscribeAuthenticatedElectronRealtimeChannel, type ElectronManagedRealtimeChannel } from '../../../../realtime-channel';
import { currentAccountAccessToken } from './account-token';

/**
 * #1928 The word the built-in 已安排 panel listens for (`subscribeChanges`): `assistant_panel_changed` on the person's own
 * event channel, sent by the cloud with each committed panel change and each publication of the assistant's home. One
 * channel per account however many watches, on a host-owned connection of its own: realtime-js hands back the existing
 * object for a topic already open on a client, and main's own client has this topic open for the assistant's work — a
 * watch must never attach to or retire that one. Told again on every (re)subscription, when words may have been missed.
 */

type Listener = { assistantId: string; changed(): void };
type Bus = { listeners: Set<Listener>; stop(): void };
const buses = new Map<string, Bus>();

function openBus(ownerId: string): Bus {
  const listeners = new Set<Listener>();
  const token = async () => {
    const value = await currentAccountAccessToken();
    return value && userIdFromSupabaseAccessToken(value) === ownerId ? value : null;
  };
  const client = createElectronRealtimeClient(token);
  const tell = (assistantId: string | null) => {
    for (const listener of [...listeners]) if (assistantId === null || listener.assistantId === assistantId) listener.changed();
  };
  const create = () =>
    (client.channel(`gugu:user:${ownerId}:events`, { config: { private: true } }) as unknown as {
      on(kind: 'broadcast', filter: { event: string }, fn: (message?: { payload?: Record<string, unknown> }) => void): ElectronManagedRealtimeChannel;
    }).on('broadcast', { event: 'assistant_panel_changed' }, (message) => {
      const assistantId = message?.payload?.assistantId;
      if (typeof assistantId === 'string') tell(assistantId);
    });
  let unsubscribe: (() => Promise<void>) | null = null;
  let stopped = false;
  const close = (off: () => Promise<void>) => void off().catch(() => undefined).finally(() => client.realtime.disconnect());
  void subscribeAuthenticatedElectronRealtimeChannel(
    { realtime: client.realtime, removeChannel: (channel) => client.removeChannel(channel as never) },
    create(),
    {
      label: `app-schedules:${ownerId}`,
      createChannel: create,
      onStatus: (status) => {
        const name = subscribeStatusName(status);
        if (!stopped && (name === 'SUBSCRIBED' || name.endsWith('.SUBSCRIBED'))) tell(null);
      },
      reconnectOnStatus: isSubscribeFailure,
    },
  ).then((off) => {
    if (stopped) close(off);
    else unsubscribe = off;
  }, (error: unknown) => {
    // Never opened: the next watch opens its own; this one's watches hear nothing more.
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'assistant panel change channel did not subscribe');
    if (buses.get(ownerId) === bus) buses.delete(ownerId);
    client.realtime.disconnect();
  });
  const bus: Bus = {
    listeners,
    stop() {
      stopped = true;
      if (unsubscribe) close(unsubscribe);
    },
  };
  return bus;
}

/** `changed` whenever the cloud says this account's assistant panel for `assistantId` changed, or may have. */
export function onAssistantPanelChanged(ownerId: string, assistantId: string, changed: () => void): () => void {
  let bus = buses.get(ownerId);
  if (!bus) buses.set(ownerId, (bus = openBus(ownerId)));
  const listener: Listener = { assistantId, changed };
  bus.listeners.add(listener);
  const mine = bus;
  return () => {
    if (!mine.listeners.delete(listener) || mine.listeners.size > 0) return;
    if (buses.get(ownerId) === mine) buses.delete(ownerId);
    mine.stop();
  };
}
