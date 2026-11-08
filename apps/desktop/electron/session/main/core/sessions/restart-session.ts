import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import { forgetLostAcpSession } from '@main/core/acp/runtime-process/host';
import type { SessionConfig } from '@shared/core/sessions/session-config';
import { failedOnMissingEngineSession } from '@shared/core/sessions/session-life';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { hydrateSession } from './hydrateSession';
import { sessionLife } from './session-life';
import { lifeStore } from './session-pending';

/**
 * spec session-resume:引擎侧什么都没有的会话,**换一条新的引擎会话,什么都不自动跑**。
 *
 * 走到这里的只有两种会话,它们留下的是同一种状态:首轮没跑完的(建完就关、首轮本身失败),
 * 和跑完过但引擎侧那条会话后来没了的(rollout 被删、被归档)。两种都不是故障,缺的是
 * 一次尚未发生的启动。
 *
 * 这里只清掉那条没了的引擎会话。新引擎等下一句话才起,起的时候带上此前的回合(prior-conversation,
 * 新开时记边界)。❌ 不重放首轮:那句话的工具可能有副作用,点「接着聊」不等于同意再做一遍。
 * 已经排在队里的话是人或别的会话真说过的,照常投递。
 *
 * 只换「引擎那侧确实没了」的会话:库里标了 `providerSessionState === 'missing'`,或启动正因为它失败停着
 * (标记只在库里还是失败的那条引擎会话时才写得上,写不上时横幅照样在,按钮不能是死的)。别的什么都不做:
 * 另一个窗口、手机上还挂着的按钮晚到一步时,这条会话可能已经接着聊上了(❌ 再换一次会掐断正在跑的那一轮),
 * 或者是鉴权、额度、网络失败停着(❌ 引擎会话本身是好的,不能扔)。
 *
 * ❌ 不是「新建一条顶上」:会话 id、标题、在任务里的位置全都原样保留。
 */
export async function restartSession(
  projectId: string,
  sessionId: string
): Promise<{ replaced: boolean }> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.projectId, projectId),
      )
    )
    .limit(1);
  if (!row) throw new Error('Session not found');
  if (!row.config) throw new Error(`Session has no config: ${sessionId}`);

  const replaceable = row.config.providerSessionState === 'missing'
    || (row.runtime === 'acp' && failedOnMissingEngineSession(sessionLife().read(sessionId)));
  if (!replaceable) {
    log.info('restartSession: the engine session is not missing; nothing to replace', { sessionId });
    return { replaced: false };
  }

  // providerSessionState 必须整键去掉,而不是置 undefined —— 版本化 JSON 列写的是
  // JSON.stringify 的结果,一个 `undefined` 值会连键一起消失,但显式留键更容易被下一个人
  // 误读成「有这个状态,只是空的」。首轮的投递载荷(initialPrompt / initialQueue)去掉:留着会被下一次首启投出去。
  // 首轮的欠条(initialMessageId)跟着那一轮走:首轮那一行还排着(首次投递时 adapter 就没了),它照常投,
  // 落那条聊天行要它(main.ts @@@5004);已经投过就一起去掉,否则下一次首启因为没带载荷被拒。
  const firstTurnQueued = row.runtime === 'acp'
    && lifeStore.unaccepted(sessionId).some(pending => pending.turn.kind === 'chat-page-first-turn' && pending.state === 'queued');
  const { providerSessionState: _cleared, initialPrompt: _prompt, initialMessageId, ...rest } = row.config;
  const owed = firstTurnQueued && initialMessageId ? { initialMessageId } : {};
  let nextConfig: SessionConfig;
  if (rest.type === 'acp') {
    const { initialQueue: _queued, ...acp } = rest;
    nextConfig = { ...acp, ...owed };
  } else nextConfig = { ...rest, ...owed };

  const updated = await db
    .update(sessions)
    .set({
      config: nextConfig,
      // sessionId 归零 = 下一次启动按「首次启动」走(hydrateSession 用的就是这把尺子)。
      providerSessionId: null,
      updatedAt: new Date().toISOString(),
    })
    // 只换刚才读到的那一行:两个窗口同时点,后到的那次在这里落空(provider id 已经是空的也一样:比的还有 updatedAt)。
    .where(and(
      eq(sessions.id, sessionId),
      row.providerSessionId === null ? isNull(sessions.providerSessionId) : eq(sessions.providerSessionId, row.providerSessionId),
      eq(sessions.updatedAt, row.updatedAt),
    ))
    .returning({ id: sessions.id });
  if (updated.length === 0) return { replaced: false };
  // 上一轮的状态到此为止,新引擎还没有任何一轮在跑。
  await agentStatusWriter.restart({ sessionId, projectId });

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId,
    // `sessionId` 清空用 `null` 而不是 `undefined` —— JSON 传输会把值为 undefined 的键整个丢掉,
    // 于是网页宿主那条上「清空」变成「什么都没说」(见 sessionChangedChannel 的抬头)。
    // `providerSessionState` 同一个坑、同一个写法(#7223 收的)。
    changes: { providerSessionState: null, providerSessionId: null },
  });

  log.info('restartSession: cleared the engine session; waiting for the next message', {
    sessionId,
    type: row.runtime,
  });

  // pty 在主进程这边就地重起,空着等人。ACP 只把上一次的残局收掉,下一句话由 session-life 起它。
  if (row.runtime === 'acp') {
    await sessionLife().interrupt(sessionId, { k: 'interrupt', reason: 'reconfigure' });
    // 运行时那条 lost 记录还钉着没了的引擎会话,下一次启动会去载它;换掉了就忘掉它(崩溃收尾不忘:侧聊靠它接回自己)。
    await forgetLostAcpSession(sessionId);
    if (lifeStore.pending(sessionId).queued.length > 0) sessionLife().start(sessionId, 'retry');
  } else {
    await hydrateSession(projectId, sessionId);
  }
  return { replaced: true };
}
