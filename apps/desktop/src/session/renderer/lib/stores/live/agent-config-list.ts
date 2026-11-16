import { agentConfigListSchema, type AgentConfigList } from '@gugu/session-core/workspace-server/agent-config';
import { ReplicaState } from '@gugu/session-wire';
import { createImmutableMobxStore } from '@gugu/session-wire/util/mobx';
import { reaction } from 'mobx';
import { replica } from '@/lib/replica';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { log } from '@renderer/utils/logger';

/** Open a machine's live agent list; each value goes to `next`, a failure to open it to `fail`. Returns close. */
function openList(machine: string | null, next: (value: AgentConfigList) => void, fail: (error: unknown) => void): () => void {
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
    stopReaction = reaction(() => live.current(), next, { fireImmediately: true });
  })().catch((error: unknown) => { if (!disposed) fail(error); });
  return () => {
    disposed = true;
    stopReaction?.();
    void agents?.dispose();
  };
}

/** Follow a machine's list while it is shown; a feed that failed says so (read again) and opens again once a read answers. */
function followList(machine: string | null): () => void {
  let close = () => {};
  let waitForAnswer = () => {};
  const open = () => {
    close = openList(machine, (value) => agentConfigList.at(machine).set(value), (error) => {
      log.warn('Agent config list subscription failed', { machine, error });
      waitForAnswer = agentConfigList.subscribe([machine], ({ reading, fetching }) => {
        if (fetching || reading.state !== 'value' || reading.error) return;
        waitForAnswer();
        open();
      });
      void agentConfigList.refresh(machine);
    });
  };
  open();
  return () => { waitForAnswer(); close(); };
}

/**
 * A machine's agent configuration list (`agents.list` live state of its agent-config worker; null = this computer): read
 * once, then fed by one live subscription per machine while a surface shows it (`watch`). A failure is the reading's,
 * so a surface opening later reads again. Owner: the signed-in account (the replica's lifecycle).
 */
export const agentConfigList = replica({
  name: 'agentConfigList',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: string | null) => new Promise<AgentConfigList>((resolve, reject) => {
    const close = openList(machine, (value) => { queueMicrotask(close); resolve(value); }, reject);
  }),
  fresh: Infinity,
  watch: { group: (machine) => machine, start: (_owner, machine) => followList(machine) },
});
