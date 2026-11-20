import type { AgentState } from '../models/agents';
import type { ToolNode, TranscriptItem, TranscriptTurn } from '../models/turns';
import type { ParserState } from './reducer';
import { entityIndex } from './entity-owner';

/**
 * Project a native child's current facts onto its original launch row without changing that call's outcome.
 *
 * `previous`: the state this one was reduced from, already projected. A committed turn it already held only needs
 * projecting again when it launched an agent that changed since; without this a replay walks every committed item on
 * every event.
 */
export function projectSubagentProgress(state: ParserState, previous?: ParserState): ParserState {
  const owners = new Map(state.agents.filter((agent) => agent.subagentSessionId).map((agent) => [agent.toolCallId, agent]));
  if (owners.size === 0) return state;
  function nodes<T extends TranscriptItem | ToolNode>(items: T[]): T[] {
    let changed = false;
    const next = items.map((item) => {
      let result: T = item;
      if (item.kind === 'spawn-subagent-tool-call') {
        const agent = owners.get(item.toolCallId);
        if (agent && differs(item, agent)) result = { ...item, agentStatus: agent.status, canCancel: agent.canCancel === true,
          agentStartedAt: agent.startedAt,
          // What it wrote lands on the card once, when it settles (#2500). While it runs the text grows with every
          // chunk; writing each chunk onto the card rewrote the whole launching turn in storage every time. The
          // running text is read from the registry.
          ...(agent.status === 'running' ? {} : { outputText: agent.output, reasoningText: agent.reasoning }),
          ...(agent.model ? { model: agent.model } : {}),
        };
      }
      if ('children' in result && result.children?.length) {
        const children = nodes(result.children);
        if (children !== result.children) result = { ...result, children };
      }
      changed ||= result !== item;
      return result;
    });
    return changed ? next : items;
  }
  function turn(value: TranscriptTurn): TranscriptTurn {
    const items = nodes(value.items);
    return items === value.items ? value : { ...value, items };
  }
  const kept = new Set(previous?.agents);
  const relaunched = state.agents.filter((agent) => agent.subagentSessionId && !kept.has(agent)).map((agent) => agent.toolCallId);
  const settled = (value: TranscriptTurn, index: number): boolean => previous?.transcript.committed[index] === value
    && !relaunched.some((id) => entityIndex(value).toolCallIds.has(id));
  const committed = previous?.transcript.committed === state.transcript.committed && relaunched.length === 0
    ? state.transcript.committed
    : state.transcript.committed.map((value, index) => settled(value, index) ? value : turn(value));
  const changed = committed !== state.transcript.committed && committed.some((value, index) => value !== state.transcript.committed[index]);
  const active = state.transcript.active ? turn(state.transcript.active) : null;
  return !changed && active === state.transcript.active ? state : { ...state, transcript: {
    committed: changed ? committed : state.transcript.committed, active,
  } };
}

function differs(item: Extract<ToolNode, { kind: 'spawn-subagent-tool-call' }>, agent: AgentState): boolean {
  return item.agentStatus !== agent.status || item.canCancel !== (agent.canCancel === true) || item.agentStartedAt !== agent.startedAt ||
    (agent.status !== 'running' && (item.outputText !== agent.output || item.reasoningText !== agent.reasoning)) ||
    (agent.model !== undefined && item.model !== agent.model);
}
