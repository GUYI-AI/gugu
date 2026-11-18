import type { AcpRuntimeStartInput } from '@gugu/session-core/acp';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '@main/core/session-timeline/locate';
import { recordIdentityFor } from '@main/core/sessions/record-backfill-match';

export type ResumeHistoryFacts = Pick<AcpRuntimeStartInput, 'replayHistory' | 'recordedDeliveryIds' | 'turnIndexBase'>;

type Deps = {
  recordedDeliveryIds?: (conversationId: string) => Promise<string[] | null>;
  turnIndexBase?: (conversationId: string) => Promise<number>;
  /** 起之前先把记录里有、库里还没有的那几轮补进库(编程模式里刚跑完的、咕咕外面跑的)。 */
  fillFromRecord?: (conversationId: string) => Promise<{ status?: string } | undefined>;
};

/**
 * #980 接回一条已有会话时,要不要让 agent 把历史重放一遍。
 *
 * 宿主读得懂这家的记录 ⇒ **不重放**:会话页的历史以 agent 自己的记录为准、由宿主直接读文件补齐,重放回来的
 * 东西本来就会被丢掉;重放本身在长会话上是几分钟的独占。重放顺带供给的两样事实改由宿主自己给:
 * - 补投去重要的「agent 收到过哪些投递」—— 记录里用户消息带的投递 id。补库读记录时顺手记下,与游标一起存着
 *   (`recordedDeliveryIds`):从游标读时累加,从头读时重算,所以不用再读一遍整份记录;
 * - 回合序号从库里接着数,❌ 从 0 数撞上上一次运行留下的同名回合。
 *
 * 记录这次读不出来(没有、读失败)⇒ 照旧重放:那是 agent 自己那份历史唯一还拿得到的路。
 * 只有 Claude、Codex、Hermes 三家不重放(`recordIdentityFor`);其余几家照旧重放。新开、分叉、还没有 provider 会话的不是「接回」,三格都不带。
 * 读不了记录的那几家也带上回合序号:适配器只声明了 `session/resume` 时运行时不会有重放,回合从库尾接着数
 * (用不用由运行时按适配器的能力定,重放的那几家照旧从 0 数)。
 * 三格**无条件写回**(缺席也写成 undefined):它们只由宿主给,渲染进程递来的同名字段不许穿过。
 */
export async function resumeHistoryFacts(input: AcpRuntimeStartInput, deps: Deps): Promise<ResumeHistoryFacts> {
  const none: ResumeHistoryFacts = { replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined };
  if (!input.providerSessionId || input.forkFromProviderSessionId) return none;
  const readTurnIndexBase = deps.turnIndexBase
    ?? (async (id: string) => (await import('@main/core/sessions/session-turn-store')).storedTurnIndexBase(id));
  if (!recordIdentityFor(sessionRecordHarnessForProvider(input.providerId))) {
    try {
      return { ...none, turnIndexBase: await readTurnIndexBase(input.sessionId) };
    } catch (error) {
      log.warn('[acp-start] turn index base unavailable', { sessionId: input.sessionId, error: String(error) });
      return none;
    }
  }
  const readDeliveries = deps.recordedDeliveryIds
    ?? (async (id: string) => (await import('@main/core/sessions/record-backfill')).recordedDeliveryIds(id));
  const fill = deps.fillFromRecord
    ?? (async (id: string) => (await import('@main/core/sessions/record-backfill')).syncStoredHistoryFromRecord(id));
  try {
    // 补库在前:之后的轮从补完的库尾接着数,投递 id 也是补库时记下的。补库抛错 = 这两样都定不下来 ⇒ 落到下面的 catch:
    // 记一笔、照旧重放(不挡启动)。❌ 吞掉后当「补完了」:那几轮既不进库也不重放,还没有任何日志。
    const filled = await fill(input.sessionId);
    // No record to read: the agent's own replay is the only history left (as when the old whole read failed).
    if (filled?.status === 'unavailable') {
      log.warn('[acp-start] record unreadable; resuming with replay', { sessionId: input.sessionId });
      return none;
    }
    const [recordedDeliveryIds, turnIndexBase] = await Promise.all([
      readDeliveries(input.sessionId),
      readTurnIndexBase(input.sessionId),
    ]);
    if (recordedDeliveryIds === null) {
      log.warn('[acp-start] record unreadable; resuming with replay', { sessionId: input.sessionId });
      return none;
    }
    return { replayHistory: false, recordedDeliveryIds, turnIndexBase };
  } catch (error) {
    // 回合从哪接着数都定不下来时,不重放就可能撞号 ⇒ 这一次照旧重放:慢,但对。
    log.warn('[acp-start] resume facts unavailable; resuming with replay', { sessionId: input.sessionId, error: String(error) });
    return none;
  }
}
