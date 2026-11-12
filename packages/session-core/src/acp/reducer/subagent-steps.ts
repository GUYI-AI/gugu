import type { AgentState } from '../models/agents';
import type { ToolNode } from '../models/turns';
import { foldItem } from './item-fold';
import type { NormalizedEvent } from './normalized-event';

type StepEvent = Extract<NormalizedEvent, { kind: 'tool_call' | 'tool_update' | 'subagent' | 'search' | 'mcp_tool' | 'web_fetch' }>;
type StepNode = Exclude<ToolNode, { kind: 'tool-group' }>;

/** Arguments are shown in the panel as one clipped line; a file body written by the call is not a header. */
const HEADER_TEXT_LIMIT = 2_000;

/**
 * A subagent's call as the registry keeps it (#2500): what was called and how it ended. The output, pictures and
 * diff bodies are not kept. No surface draws them, and they are what made the launching turn megabytes large.
 */
function header(node: StepNode, seq: number): StepNode {
  const { rawOutput: _rawOutput, outputText: _outputText, images: _images, imageRefs: _imageRefs,
    contentBlocks: _contentBlocks, children: _children, trimmedChars: _trimmedChars, parentToolCallId: _parent, ...kept } = node;
  const clip = (text: string | undefined) => text !== undefined && text.length > HEADER_TEXT_LIMIT ? text.slice(0, HEADER_TEXT_LIMIT) : text;
  const rawInput = clip(kept.rawInput);
  const inputSummary = clip(kept.inputSummary);
  return { ...kept, seq, ...(rawInput !== undefined ? { rawInput } : {}), ...(inputSummary !== undefined ? { inputSummary } : {}) } as StepNode;
}

/**
 * Fold one event of a subagent's own stream into its flat step list. A call is one entry for its whole life; a
 * later event for the same call replaces that entry and keeps its place.
 */
export function foldSubagentStep(
  steps: readonly ToolNode[],
  event: StepEvent,
  scope: string,
  at: number,
  stampAt: number | undefined
): readonly ToolNode[] {
  const toolCallId = 'toolCallId' in event ? event.toolCallId : undefined;
  if (!toolCallId) return steps;
  const index = steps.findIndex((step) => 'toolCallId' in step && step.toolCallId === toolCallId);
  const previous = index >= 0 ? steps[index]! : undefined;
  // The fold is the one place that knows how an event becomes a tool node; it runs here on this call alone.
  const folded = foldItem(previous ? [previous] : [], { ...event, parentToolCallId: null } as StepEvent, scope, at, stampAt);
  const node = folded.find((item): item is StepNode => 'toolCallId' in item && item.toolCallId === toolCallId);
  if (!node) return steps;
  const next = header(node, previous ? previous.seq : steps.length);
  if (previous && sameHeader(previous, next)) return steps;
  return index >= 0 ? steps.map((step, i) => (i === index ? next : step)) : [...steps, next];
}

function sameHeader(a: ToolNode, b: ToolNode): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const x = left[key];
    const y = right[key];
    if (x === y) continue;
    if (typeof x === 'object' && typeof y === 'object' && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

/** The step a call id names, with the subagent that made it. */
export function findSubagentStep(
  agents: readonly AgentState[],
  match: (step: StepNode) => boolean
): { agent: AgentState; step: StepNode } | null {
  for (const agent of agents) {
    for (const step of agent.steps ?? []) {
      if (step.kind !== 'tool-group' && match(step)) return { agent, step };
    }
  }
  return null;
}

/** Write a few settled fields onto one step; every other agent and step keeps its identity. */
export function patchSubagentStep(
  agents: readonly AgentState[],
  toolCallId: string,
  patch: Partial<StepNode>
): AgentState[] | null {
  let hit = false;
  const next = agents.map((agent) => {
    if (!agent.steps?.some((step) => 'toolCallId' in step && step.toolCallId === toolCallId)) return agent;
    hit = true;
    return { ...agent, steps: agent.steps.map((step) =>
      'toolCallId' in step && step.toolCallId === toolCallId ? ({ ...step, ...patch } as ToolNode) : step),
      activityVersion: (agent.activityVersion ?? 0) + 1 };
  });
  return hit ? next : null;
}
