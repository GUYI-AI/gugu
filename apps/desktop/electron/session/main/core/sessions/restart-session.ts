import { and, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer';
import type { SessionConfig } from '@shared/core/sessions/session-config';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { hydrateSession } from './hydrateSession';
import { sessionLife } from './session-life';
import { lifeStore } from './session-pending';
import { storedTurnEnd } from './session-turn-store';

/**
 * spec session-resume:引擎侧什么都没有的会话,**换一条新的引擎会话,什么都不自动跑**。
 *
 * 走到这里的只有两种会话,它们留下的是同一种状态:首轮没跑完的(建完就关、首轮本身失败),
 * 和跑完过但引擎侧那条会话后来没了的(rollout 被删、被归档)。两种都不是故障,缺的是
 * 一次尚未发生的启动。
 *
 * 这里只清掉那条没了的引擎会话,并记下「此前的回合到哪」(`priorTurnsBefore`)。新引擎等下一句话才起,
 * 起的时候带上那段前文(prior-conversation)。❌ 不重放首轮:那句话的工具可能有副作用,点「接着聊」
 * 不等于同意再做一遍。已经排在队里的话是人或别的会话真说过的,照常投递。
 *
 * ❌ 不是「新建一条顶上」:会话 id、标题、在任务里的位置全都原样保留。
 */
export async function restartSession(
  projectId: string,
  sessionId: string
): Promise<void> {
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

  // providerSessionState 必须整键去掉,而不是置 undefined —— 版本化 JSON 列写的是
  // JSON.stringify 的结果,一个 `undefined` 值会连键一起消失,但显式留键更容易被下一个人
  // 误读成「有这个状态,只是空的」。首轮的投递载荷和它的欠条(initialMessageId)一起去掉:
  // 载荷留着会被下一次首启投出去,欠条留着则下一次首启因为没带载荷被拒(main.ts @@@5004)。
  const { providerSessionState: _cleared, initialPrompt: _prompt, initialMessageId: _owed, ...rest } = row.config;
  const priorTurnsBefore = await storedTurnEnd(sessionId);
  let nextConfig: SessionConfig;
  if (rest.type === 'acp') {
    const { initialQueue: _queued, ...acp } = rest;
    nextConfig = { ...acp, priorTurnsBefore };
  } else nextConfig = { ...rest, priorTurnsBefore };

  await db
    .update(sessions)
    .set({
      config: nextConfig,
      // sessionId 归零 = 下一次启动按「首次启动」走(hydrateSession 用的就是这把尺子)。
      providerSessionId: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(sessions.id, sessionId));
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
    priorTurnsBefore,
  });

  // pty 在主进程这边就地重起,空着等人。ACP 只把上一次的残局收掉,下一句话由 session-life 起它。
  if (row.runtime === 'acp') {
    await sessionLife().interrupt(sessionId, { k: 'interrupt', reason: 'reconfigure' });
    if (lifeStore.pending(sessionId).queued.length > 0) sessionLife().start(sessionId, 'retry');
  } else {
    await hydrateSession(projectId, sessionId);
  }
}
