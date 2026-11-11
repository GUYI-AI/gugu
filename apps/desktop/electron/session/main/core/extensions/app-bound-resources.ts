import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import {
  AssistantPanelError, createAssistantPanelClient, type AssistantPanelDomain,
} from '@gugu/core/cloud/assistantPanel';
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies';
import { withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead';
import { pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision';
import { splitInstructions } from '@gugu/core/shared/assistantInstructions';
import { domainState, refusedOrUnavailable, savedData, writeOutcome } from '@shared/extensions/bound-resources-core';
import { DEFAULT_TEXT_MAX_BYTES } from '@shared/extensions/app-runtime-protocol';
import {
  READABLE_RESOURCE_DOMAINS, WRITABLE_RESOURCE_DOMAINS, appResourceOf, resourceChangeSchema, resourceDomainOf, resourceKeyOf,
  type AppResourceEvent, type AppResourceList, type AppResourceRead, type AppResourceWrite, type ReadableResourceDomain, type ResourceBindingAction,
} from '@shared/extensions/agent-resources';
import { account, current, member } from './app-unread-bindings';
import { extensionsService } from './extensions-root';
import { addResourceWatch, stopResourceWatch } from './app-resource-watches';

/**
 * #1927 (API 42): an App's window onto the panel resources of the signed-in person's personal assistant, when its private
 * conversation with them is the conversation the person chose for the App's binding. The App names the binding, a domain
 * and a key; the owner comes from the account's token, the conversation from the person's own selection for this installed
 * App, and the agent from the account's own assistant provision. Reads and changes go through the existing resource store (the
 * `assistant_panel_*` calls and its private-folder bodies) as the person, so its revision checks, tombstones, operation ids
 * and apply receipts hold as they do for the assistant's own pages. Everything is checked again after every wait.
 */

const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' });
const failed = (message: string) => Object.assign(new Error(message), { code: 'failed' });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
function argsOf<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid(`gugu.bindings takes the binding's name, a resource domain and key, never an owner, agent, chat or path (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`);
  return parsed.data;
}

// What `pickAssistant` reads (ASSISTANT_PROVISION_SELECT), plus the private conversation and the identity's owner.
const PERSONAL_ASSISTANT_SELECT = 'agent_user_id,device_id,member_key,phase,created_at,dm_chat_id,agent:users!agent_provisions_agent_user_id_fkey(owner_user_id,removed_at)';

/**
 * The agent the bound conversation is with, which must be the signed-in person's personal assistant — the one the
 * assistant's own pages show (`pickAssistant`, as `personalAssistant` picks it), in a phase the store serves (ready or
 * completed, as `assistant_panel_is_owner` asks), owned and not removed, whose provision names this very conversation as
 * its private one. Only it has panel resources: anything else — another of the person's agents, someone else's, a group,
 * a person — is refused here, before the store is asked.
 */
async function personalAssistantOf(token: string, ownerId: string, chatId: string): Promise<string> {
  const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
  const { data, error } = await client.from('agent_provisions').select(PERSONAL_ASSISTANT_SELECT)
    .eq('owner_user_id', ownerId).eq('member_key', 'assistant').limit(32).abortSignal(AbortSignal.timeout(5000));
  if (error) throw failed('Could not verify the agent of the chosen conversation');
  type Identity = { owner_user_id?: unknown; removed_at?: unknown };
  type Row = Omit<AssistantProvisionRow, 'agent'> & { dm_chat_id?: unknown; agent: Identity | Identity[] | null };
  const rows = (data ?? []) as Row[];
  let pick: ReturnType<typeof pickAssistant>;
  try {
    // Its own check of each identity: exactly one, its removal said (null or a time), else it throws.
    pick = pickAssistant(rows as AssistantProvisionRow[]);
  } catch {
    throw failed('Could not verify the agent of the chosen conversation');
  }
  const served = pick && rows.some((row) => {
    const agent = Array.isArray(row.agent) ? row.agent.length === 1 ? row.agent[0] : null : row.agent;
    return row.agent_user_id === pick.agentId && row.member_key === 'assistant' && row.dm_chat_id === chatId
      && ['ready', 'completed'].includes(String(row.phase)) && agent?.owner_user_id === ownerId && agent.removed_at === null;
  });
  if (!pick || !served) throw denied('The chosen conversation is not your private conversation with your personal assistant');
  return pick.agentId;
}

type Bound = { ownerId: string; token: string; chatId: string; handle: string; agentId: string; recheck(): Promise<void> };

/**
 * The authority one call works under: the current account's own selection for this installed App, with the action granted
 * (and, for a domain, that domain listed for it), of a conversation the account is still in, which is its private one with
 * its personal assistant (asked beside membership). `recheck`: account, installed App, grant and the same selection, still —
 * called after every wait. Null: nobody has chosen the conversation yet.
 */
async function boundAgent(extensionId: string, name: string, needs: readonly ResourceBindingAction[], domain: string | null): Promise<Bound | null> {
  const { token, ownerId } = await account();
  const service = extensionsService();
  // Every action the call needs, each granted (a change needs reading the domain too): one binding behind them all.
  const grant = () => needs.map((action) => domain === null
    ? service.conversationBinding(ownerId, extensionId, name, action)
    : service.conversationResourceBinding(ownerId, extensionId, name, action, domain)).at(-1) ?? null;
  const before = grant();
  if (!before) return null;
  const recheck = async () => {
    await current(ownerId);
    if (grant()?.handle !== before.handle) throw denied('Conversation binding changed');
  };
  const [membership, agent] = await Promise.allSettled([member(token, ownerId, before.chatId), personalAssistantOf(token, ownerId, before.chatId)]);
  // A refusal outweighs a check that could not be made: the call is refused, not to be tried again.
  const rejected = [membership, agent].filter((check): check is PromiseRejectedResult => check.status === 'rejected');
  const refusal = rejected.find((check) => codeOf(check.reason) === 'denied') ?? rejected[0];
  if (refusal) throw refusal.reason;
  await recheck();
  return { ownerId, token, chatId: before.chatId, handle: before.handle, agentId: (agent as PromiseFulfilledResult<string>).value, recheck };
}

/** The store, as the signed-in person; a call made after the account changed is refused before it is sent. */
function storeOf(ownerId: string) {
  return createAssistantPanelClient(async (rpc, args) => {
    const { token, ownerId: now } = await account().catch(() => ({ token: '', ownerId: null }));
    if (now !== ownerId) throw new AssistantPanelError('account-changed', 'Assistant panel account changed');
    const client = createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } });
    const { data, error, status } = await client.rpc(rpc, args).abortSignal(AbortSignal.timeout(10_000));
    return { data, error, status };
  }, () => ownerId);
}

/** Runs `use` under the binding's authority; `unbound` or `unavailable` (checked again first) said apart from a refusal. */
async function withBound<T>(extensionId: string, name: string, domain: string, use: (bound: Bound) => Promise<T>): Promise<T | 'unbound' | 'unavailable'> {
  const bound = await boundAgent(extensionId, name, ['resources'], domain).catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable' || bound === null) return bound ?? 'unbound';
  try {
    const value = await use(bound);
    await bound.recheck();
    return value;
  } catch (error) {
    const outcome = refusedOrUnavailable(error);
    await bound.recheck();
    return outcome;
  }
}

/** A domain a call names: not one of the store's is `invalid`; one never granted to an App is refused, whatever was declared. */
function readableDomainOf(value: unknown): ReadableResourceDomain {
  const domain = resourceDomainOf(value);
  if (!(READABLE_RESOURCE_DOMAINS as readonly string[]).includes(domain)) throw denied(`The ${domain} resources are never granted to an App`);
  return domain as ReadableResourceDomain;
}

/** `gugu.bindings.resources(name, domain)` (42, `chat:resources`): one domain of the agent's resources, whole. */
export async function appResourceList(extensionId: string, input: unknown): Promise<AppResourceList> {
  const args = argsOf(z.strictObject({ name: z.string(), domain: z.unknown() }), input);
  const domain = readableDomainOf(args.domain);
  const named = { name: args.name, domain };
  const answer = await withBound(extensionId, args.name, domain, async (bound): Promise<AppResourceList> => {
    const snapshot = await withAssistantPanelReadDeadline(() => storeOf(bound.ownerId).snapshot(bound.agentId));
    const readable = domainState(snapshot, domain);
    if (readable.state !== 'ready') return { ...named, state: readable.state };
    return { ...named, state: 'ready', revision: snapshot.revision, resources: readable.items.map((item) => appResourceOf(domain, item)) };
  });
  return typeof answer === 'string' ? { ...named, state: answer } : answer;
}

/** `gugu.bindings.resource(name, domain, key)` (42, `chat:resources`): one resource and its content, up to 20 MiB of it. */
export async function appResourceRead(extensionId: string, input: unknown): Promise<AppResourceRead> {
  const args = argsOf(z.strictObject({ name: z.string(), domain: z.unknown(), key: z.unknown() }), input);
  const domain = readableDomainOf(args.domain);
  const key = resourceKeyOf(domain, args.key);
  const named = { name: args.name, domain, key };
  const answer = await withBound(extensionId, args.name, domain, async (bound): Promise<AppResourceRead> => {
    const store = storeOf(bound.ownerId);
    // One resource is read only from a domain that can be read (as the assistant's pages read one: `bytes` → `find` →
    // `collection`), voice notes excepted as there.
    const [snapshot, item] = await Promise.all([
      domain === 'voice-notes' ? null : withAssistantPanelReadDeadline(() => store.snapshot(bound.agentId)),
      withAssistantPanelReadDeadline(() => store.resource(bound.agentId, domain as AssistantPanelDomain, key)),
    ]);
    await bound.recheck();
    const readable = snapshot ? domainState(snapshot, domain) : null;
    if (readable && readable.state !== 'ready') return { ...named, state: readable.state };
    if (!item) return { ...named, state: 'missing', revision: '0' };
    // A deleted resource stays deleted: its tombstone's revision is what bringing it back (where the domain allows) expects.
    if (item.deleted_at) return { ...named, state: 'missing', revision: item.revision, deleted: true };
    if (item.stale_at) return { ...named, state: 'unavailable' };
    const resource = appResourceOf(domain, item);
    const ready = (bytes: Uint8Array) => {
      if (bytes.byteLength > DEFAULT_TEXT_MAX_BYTES) return { ...named, state: 'ready' as const, resource, content: '', truncated: true, totalSize: bytes.byteLength };
      try {
        return { ...named, state: 'ready' as const, resource, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), truncated: false, totalSize: bytes.byteLength };
      } catch {
        return { ...named, state: 'ready' as const, resource, content: '', binary: true as const, truncated: false, totalSize: bytes.byteLength };
      }
    };
    // Personality keeps its text in the resource itself; a folder has no content.
    if (domain === 'personality') return ready(new TextEncoder().encode(typeof item.data.text === 'string' ? item.data.text : ''));
    if (!item.body_item_id) return item.data.kind === 'directory' ? ready(new Uint8Array()) : { ...named, state: 'unprepared' };
    try {
      return ready(await readAssistantPanelBody(item, {
        token: bound.token, ownerId: bound.ownerId, chatId: bound.chatId, maxBytes: DEFAULT_TEXT_MAX_BYTES,
        accountId: async () => (await account().catch(() => null))?.ownerId ?? null,
      }));
    } catch (error) {
      const code = codeOf(error);
      if (code === 'too-large') return { ...named, state: 'ready', resource, content: '', truncated: true, totalSize: Number((error as { size?: unknown }).size) || 0 };
      if (code === 'deleted') return { ...named, state: 'missing', revision: item.revision, deleted: true };
      // Not stored yet: an upload not placed, or no bytes behind it yet.
      if (code === 'body-unavailable') return { ...named, state: 'unprepared' };
      throw error;
    }
  });
  return typeof answer === 'string' ? { ...named, state: answer } : answer;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The one copy of what a save stores (bound-resources-core.ts), as this module said it before. */
export { savedData };

/** Removes a body this call uploaded that no change took. The store refuses removing one a change refers to. */
async function discard(bound: Bound, itemId: string): Promise<void> {
  const client = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${bound.token}` } });
  await Promise.resolve(client.rpc('workspace_delete_as', { p_item_id: itemId, p_as_user_id: bound.ownerId })).catch(() => undefined);
}

/**
 * One change through the store under the binding's write grant: committed with the caller's `operationId` and expected
 * revision — the same call again answers the same receipt, with its status now — or said why not.
 */
type Writable = 'memory' | 'files' | 'personality' | 'skills';
type Prepared = { data: Record<string, unknown>; body?: { itemId: string; sha256: string }; uploaded?: string } | 'conflict';
type Change = { domain: Writable; key: string; expectedRevision: string; content: string };

async function change(
  extensionId: string, input: unknown, operation: 'save' | 'remove', prepare: (bound: Bound, change: Change) => Promise<Prepared>,
): Promise<AppResourceWrite> {
  const schema = operation === 'save'
    ? resourceChangeSchema.extend({ name: z.string(), content: z.string() })
    : resourceChangeSchema.omit({ content: true }).extend({ name: z.string() });
  const args = argsOf(schema, input) as z.infer<typeof resourceChangeSchema> & { name: string };
  const domain = readableDomainOf(args.domain) as Writable;
  // Whatever a grant says, what only the recorder and transcription write (voice notes) is never an App's to change.
  if (!(WRITABLE_RESOURCE_DOMAINS as readonly string[]).includes(domain)) throw invalid(`The ${domain} resources are read only`);
  const key = resourceKeyOf(domain, args.key, true);
  const named = { name: args.name, domain, key };
  const content = args.content ?? '';
  if (new TextEncoder().encode(content).byteLength > DEFAULT_TEXT_MAX_BYTES) throw invalid('content is at most 20 MiB');
  const bound = await boundAgent(extensionId, args.name, ['resources', 'resources:write'], domain).catch((error: unknown) => {
    if (codeOf(error) === 'failed') return 'unavailable' as const;
    throw error;
  });
  if (bound === 'unavailable') return { ...named, state: 'unavailable' };
  if (!bound) return { ...named, state: 'unbound' };
  let uploaded: string | undefined;
  try {
    const prepared = await prepare(bound, { domain, key, expectedRevision: args.expectedRevision, content });
    if (prepared !== 'conflict') uploaded = prepared.uploaded;
    await bound.recheck();
    if (prepared === 'conflict') return { ...named, state: 'conflict' };
    const receipt = await storeOf(bound.ownerId).commit(bound.agentId, {
      operationId: args.operationId, domain, key, expectedRevision: args.expectedRevision, operation, data: prepared.data,
      ...(prepared.body ? { body: prepared.body } : {}), deviceId: null,
    });
    uploaded = undefined;
    await bound.recheck();
    const { operationId, revision, status, terminal } = receipt;
    return { ...named, state: 'committed', receipt: { operationId, revision, status, ...(terminal === undefined ? {} : { terminal }) } };
  } catch (error) {
    let outcome: ReturnType<typeof writeOutcome>;
    try {
      outcome = writeOutcome(error);
    } catch (refusal) {
      if (uploaded) await discard(bound, uploaded);
      throw refusal;
    }
    // Whether an unanswered commit landed is unknown: its body stays, for the same call again to find.
    if (uploaded && outcome !== 'unavailable') await discard(bound, uploaded);
    await bound.recheck();
    return { ...named, state: outcome };
  }
}

/**
 * `gugu.bindings.save(name, { domain, key, operationId, expectedRevision, content })` (42, `chat:resources:write`): the
 * resource's new text, stored as the assistant's own pages store it. The same content as now keeps its stored body (and
 * so the same call again is the same request); new content is uploaded to the conversation's private folder first.
 */
export async function appResourceSave(extensionId: string, input: unknown): Promise<AppResourceWrite> {
  return change(extensionId, input, 'save', async (bound, { domain, key, expectedRevision, content: text }) => {
    if (domain === 'personality') return { data: { text: splitInstructions(text).user } };
    const bytes = new TextEncoder().encode(text);
    const existing = await withAssistantPanelReadDeadline(() => storeOf(bound.ownerId).resource(bound.agentId, domain, key));
    await bound.recheck();
    if (existing && !existing.deleted_at && existing.data.kind === 'directory') throw invalid('A folder has no content to save');
    const digest = sha256(bytes);
    // Unchanged content: the stored body and its metadata as they are, so a call made again matches its first request.
    if (existing && !existing.deleted_at && existing.body_item_id && existing.body_sha256 === digest) {
      return { data: existing.data, body: { itemId: existing.body_item_id, sha256: digest } };
    }
    // Nothing is uploaded for a change the store would refuse as stale.
    if ((existing?.revision ?? '0') !== expectedRevision) return 'conflict';
    const data = savedData(domain, key, existing, text, new Date().toISOString());
    const label = domain === 'skills' ? 'SKILL.md' : key.split('/').pop()!;
    const body = await uploadAssistantPanelBody({
      token: bound.token, ownerId: bound.ownerId, chatId: bound.chatId, label, bytes,
      accountId: async () => (await account().catch(() => null))?.ownerId ?? null,
    });
    return { data, body, uploaded: body.itemId };
  });
}

/**
 * `gugu.bindings.remove(name, { domain, key, operationId, expectedRevision })` (42, `chat:resources:write`): the
 * resource deleted; the store keeps its tombstone, and its bodies go with it. One resource at a time: not a folder, and
 * never the personality, which is only ever saved.
 */
export async function appResourceRemove(extensionId: string, input: unknown): Promise<AppResourceWrite> {
  return change(extensionId, input, 'remove', async (bound, { domain, key }) => {
    if (domain === 'personality') throw invalid('The personality is saved, never removed');
    if (domain === 'files') {
      const existing = await withAssistantPanelReadDeadline(() => storeOf(bound.ownerId).resource(bound.agentId, domain, key));
      if (existing && !existing.deleted_at && existing.data.kind === 'directory') throw invalid('Remove a folder\'s files one by one');
    }
    return { data: {} };
  });
}

/**
 * `gugu.bindings.onResourcesChanged(name, fn)` (42, `chat:resources`): this page hears that the agent's resources changed,
 * for as long as the authority it was granted under holds (app-resource-watches.ts). `unbound`: nothing is watched.
 */
export async function appResourceWatch(
  extensionId: string, pageId: number, input: unknown, hear: (watchId: string, event: AppResourceEvent) => void,
): Promise<{ name: string; state: 'watching' | 'unbound' | 'stopped' }> {
  const { watchId, name, on } = argsOf(z.strictObject({ watchId: z.string().min(1).max(64), name: z.string(), on: z.boolean() }), input);
  if (!on) {
    stopResourceWatch(pageId, watchId);
    return { name, state: 'stopped' };
  }
  const bound = await boundAgent(extensionId, name, ['resources'], null);
  if (!bound) return { name, state: 'unbound' };
  const held = addResourceWatch({
    pageId, watchId, extensionId, name, ownerId: bound.ownerId, handle: bound.handle, agentId: bound.agentId,
    hear: (event) => hear(watchId, event),
  });
  if (!held) throw denied('Conversation binding changed');
  return { name, state: 'watching' };
}
