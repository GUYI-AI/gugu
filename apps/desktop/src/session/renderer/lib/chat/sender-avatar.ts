import { subscribePhoneAssistantIdentity } from '@/mobile/assistant/phoneAssistantIdentity';
import { readAssistantShellBridge } from '@/lib/assistantShellBridge';
import { observe } from 'mobx';
import type { Readable } from '@/lib/selectStore';
import { subscribeToHostTheme } from '../theme/host-theme';
import { decodeTypedId } from '@gugu/core/shared/typedId.mjs';
import { faceImageUrl, identityFace } from '@/lib/identityFace';
import { subscribeAssistantPosters } from '@/components/assistantFigure/posters';
import { readIdentityDirectoryBridge, type IdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';

/** 一条本机会话的属主 agent 的 gugu user id;没有属主(没开户 / 已被收走)⇒ undefined。 */
export type SessionOwnerLookup = (sessionId: string) => string | undefined;

/**
 * 会话 → 属主 agent:读本机花名册那张表(壳口 `agentNames`,宿主按 localAgentForSession 同一行给出,
 * 事件增量更新)。graph 寻址只发生在本机会话之间,所以发信会话的属主总在这张表里;不在 = 没有属主。
 */
const rosterOwner: SessionOwnerLookup = (sessionId) => sessionAgentBindings.bindingFor(sessionId)?.agentUserId;

/**
 * 投递卡发信人的头像(#6306):与聊天页**同一个来源、同一个投影**。
 *
 * - 来源:咕咕壳的本地身份缓存,经 identityDirectoryBridge 同步读(会话页与聊天页同一个 document)。
 * - 投影:lib/identityFace 的 identityFace + faceImageUrl —— 与聊天页 Avatar 同一个决定:有上传就是那张;没上传就是
 *   按同一个 uuid 生成的同一张脸(聊天气泡的种子也是 sender_user_id)。
 * - `session:<id>`(graph 寻址的 session-direct)画**这条会话的属主 agent** —— 与 roster 寻址那一腿(`user:<agent>`)
 *   同一个人、同一张脸。两条都写着「来自会话」,❌ 一条有头像一条没有:地址形态是传输细节,不是身份差别。
 *   会话 → agent 由宿主的花名册回答(见 rosterOwner),信封不为此多带一格(那一格对 agent 没用,却每轮进 prompt)。
 * - 返回 null = 这一格不画:
 *   · 没有身份的发信人(`system:gugu` 等,或信封没写 from_id);`session:` 的会话没有属主 agent(不猜);
 *   · 桥缺席(独立打开的会话页);
 *   · 缓存里还没有这个人 —— 同时交给缓存按需补取,补到后经订阅重读、一次填上(不先画别的再换)。
 */
export function senderAvatarUrl(
  fromId: string | null,
  bridge: IdentityDirectoryBridge | undefined = readIdentityDirectoryBridge(),
  ownerOf: SessionOwnerLookup = rosterOwner,
): string | null {
  if (!fromId || !bridge) return null;
  let userId: string;
  // 会话属主一定是 agent;`user:` 那一腿看身份自己说的 type。
  let ownerIsAgent = false;
  if (fromId.startsWith('user:')) {
    userId = decodeTypedId('user', fromId, 'delivery from_id');
  } else if (fromId.startsWith('session:')) {
    const owner = ownerOf(decodeTypedId('session', fromId, 'delivery from_id'));
    if (!owner) return null;
    userId = owner;
    ownerIsAgent = true;
  } else {
    return null;
  }
  const identity = bridge.getSnapshot()?.[userId];
  if (!identity) {
    bridge.ensure([userId]);
    return null;
  }
  return faceImageUrl(identityFace({ id: userId, avatar: identity.avatar, type: ownerIsAgent ? 'agent' : identity.type }), 'session-page delivery card');
}

/** 头像该重读的时刻:身份缓存变了,会话 → 属主那张表变了(新会话开户 / 改名事件),或小鸟的定格画好了。 */
export function subscribeSenderAvatars(listener: () => void): () => void {
  sessionAgentBindings.start();
  const offIdentities = readIdentityDirectoryBridge()?.subscribe(listener) ?? (() => {});
  const offOwners = observe(sessionAgentBindings.bindings, () => listener());
  const offPosters = subscribeAssistantPosters(listener);
  const offTheme = subscribeToHostTheme(listener);
  const offAssistant = readAssistantShellBridge()?.subscribe(listener) ?? (() => {});
  const offPhoneAssistant = subscribePhoneAssistantIdentity(listener);
  return () => {
    offPhoneAssistant();
    offIdentities();
    offOwners();
    offPosters();
    offTheme();
    offAssistant();
  };
}

let avatarsSeen = 0;
/** A count that moves whenever an avatar should be read again (❌ a reducer tick bumped from an effect). */
export const senderAvatarChanges: Readable<number> = {
  get: () => avatarsSeen,
  subscribe: (listener) => subscribeSenderAvatars(() => { avatarsSeen += 1; listener(); }),
};
