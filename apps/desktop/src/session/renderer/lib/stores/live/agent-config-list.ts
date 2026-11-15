import { agentConfigListSchema, type AgentConfigList } from '@gugu/session-core/workspace-server/agent-config';
import { ReplicaState } from '@gugu/session-wire';
import { createImmutableMobxStore } from '@gugu/session-wire/util/mobx';
import { reaction } from 'mobx';
import { observeRendererSession } from '@/lib/sessionPublication';
import { createSelectStore, type Readable, type SelectStore } from '@/lib/selectStore';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { log } from '@renderer/utils/logger';

/**
 * A machine's agent configuration list (`agents.list` live state of its agent-config worker: each harness with its
 * `auth` / `programAuth` readings), held once per machine for every surface that reads it (@@@client-state-model §1:
 * a host stream, kept in its engine's module and exposed through `createSelectStore`, the shape of running-sessions).
 *
 * The value says "not read yet" (`unknown`) apart from "read" (`value`) and "could not subscribe" (`error`): a reader
 * never draws the first as an empty list. One live subscription per machine while anyone reads it (reference counted);
 * the last value stays shown (it is the last thing that machine said) while a new subscription starts.
 *
 * Owner: the signed-in account (the worker answers for the account signed in on that machine). Signing out or another
 * account signing in clears every machine's list.
 */
export type AgentConfigListState =
  | { state: 'unknown' }
  | { state: 'value'; value: AgentConfigList }
  | { state: 'error'; error: Error };

const UNKNOWN: AgentConfigListState = { state: 'unknown' };

type Entry = { store: SelectStore<AgentConfigListState>; readers: number; stop: (() => void) | null; readable: Readable<AgentConfigListState> };
const lists = new Map<string, Entry>();

function publish(entry: Entry, next: AgentConfigListState): void {
  entry.store.publish(next);
  entry.store.notify();
}

function open(machine: string | null, entry: Entry): () => void {
  let disposed = false;
  let stopReaction: (() => void) | null = null;
  let agents: ReplicaState<AgentConfigList> | null = null;
  void (async () => {
    const client = await getAgentConfigRuntimeClient(machine);
    if (disposed) return;
    agents = new ReplicaState(client.agents.state(undefined, 'list'), { schema: agentConfigListSchema, store: createImmutableMobxStore() });
    await agents.ready;
    if (disposed) return;
    const live = agents;
    stopReaction = reaction(() => live.current(), (value) => publish(entry, { state: 'value', value }), { fireImmediately: true });
  })().catch((error: unknown) => {
    log.warn('Agent config list subscription failed', { machine, error });
    if (!disposed) publish(entry, { state: 'error', error: error instanceof Error ? error : new Error(String(error)) });
  });
  return () => {
    disposed = true;
    stopReaction?.();
    void agents?.dispose();
  };
}

function entryOf(machine: string | null): Entry {
  const key = machine ?? '';
  let entry = lists.get(key);
  if (!entry) {
    const store = createSelectStore<AgentConfigListState>(UNKNOWN);
    const created: Entry = {
      store,
      readers: 0,
      stop: null,
      readable: {
        get: store.get,
        subscribe: (listener) => {
          const off = store.subscribe(listener);
          if (created.readers++ === 0) created.stop = open(machine, created);
          return () => {
            off();
            if (--created.readers === 0) { created.stop?.(); created.stop = null; }
          };
        },
      },
    };
    entry = created;
    lists.set(key, entry);
  }
  return entry;
}

/** The agent configuration list of a machine (null = this computer), for `useSelect`. */
export function agentConfigList(machine: string | null): Readable<AgentConfigListState> {
  return entryOf(machine).readable;
}

let account: string | null = null;
/** Signing out or another account: every machine's list is the previous account's; drop it and read again where shown. */
export function forgetAgentConfigLists(): void {
  for (const [machine, entry] of lists) {
    entry.stop?.();
    entry.stop = null;
    publish(entry, UNKNOWN);
    if (entry.readers > 0) entry.stop = open(machine || null, entry);
  }
}
// As the replica's account (lib/replica.ts): only a real sign-out or another person clears; an absent session (boot
// restore, a refresh that cannot reach the network) holds.
observeRendererSession(({ event, session }) => {
  const next = session?.user.id ?? null;
  if (next) {
    if (account && account !== next) forgetAgentConfigLists();
    account = next;
  } else if (event === 'SIGNED_OUT') {
    if (account) forgetAgentConfigLists();
    account = null;
  }
});
