import { log } from '@main/lib/logger';
import { appSettingsService } from '../settings/settings-service';

type IdleCompactionClient = { setIdleCompaction(input: { enabled: boolean }): Promise<unknown> };

/**
 * #3005 设置 → 通用「离开时压缩长对话」推到 ACP 运行时:运行时每起来一次推一次,人改了设置再推一次。
 * 运行时只在定时器到点时读这一格,所以关掉对正在跑的会话立即生效。推失败只记日志:运行时那侧默认开,
 * 与 Claude Code 自己的 `idleCompaction` 仍是「任一关了就不压」。
 */
export async function pushIdleCompactionSetting(client: IdleCompactionClient | null): Promise<void> {
  if (!client) return;
  try {
    const { idleCompaction } = await appSettingsService.get('sessions');
    await client.setIdleCompaction({ enabled: idleCompaction });
  } catch (error) {
    log.warn('idle compaction setting not delivered to the ACP runtime', { error: String(error) });
  }
}
