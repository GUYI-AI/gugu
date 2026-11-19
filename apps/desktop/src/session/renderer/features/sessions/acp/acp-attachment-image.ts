import { pathAttachmentTarget } from '@gugu/session-chat-ui/markdown-attachment-mentions';
import { resolveDeliveredAttachment } from '@renderer/lib/chat/delivered-message-presentation';
import { rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import type { AcpChatStore } from './acp-chat-store';
import { resolveVisualEvidenceAttachmentDataUrl } from './acp-chat-resource-manager';

const attachmentDataUrlCache = new Map<string, Promise<string | null>>();

/** 任务页用户消息里一件附件的图:字节在哪就照哪读,读不到给 null(中性占位块)。 */
export function resolveAttachmentDataUrl(store: AcpChatStore, id: string): Promise<string | null> {
  if (id.startsWith('gugu-message-file://')) return resolveDeliveredAttachment(id);
  const fixtureDataUrl = resolveVisualEvidenceAttachmentDataUrl(store, id);
  if (fixtureDataUrl) return Promise.resolve(fixtureDataUrl);
  const machine = machineRegistry.machineOf(store.runtimeSessionId);
  const key = JSON.stringify([machine, store.runtimeSessionId, id]);
  const remember = (read: Promise<string | null>) => {
    const pending = read.then(value => {
      if (!value && attachmentDataUrlCache.get(key) === pending) attachmentDataUrlCache.delete(key);
      return value;
    });
    attachmentDataUrlCache.set(key, pending);
    return pending;
  };
  // `path:` 附件(agent 给主人的通知里的文件、投递卡里人类工具交回的图):字节在盘上,不在 agent 的附件仓里 —— 照那条路径读。
  const path = pathAttachmentTarget(id);
  if (path) {
    const cachedPath = attachmentDataUrlCache.get(key);
    if (cachedPath) return cachedPath;
    // 字节在会话所在的那台机器上(别的机器上的会话 = 问那台机器)。
    const promise = rpcOn(machine).app.readUserImageDataUrl(path)
      .then((result) => (result.success ? result.dataUrl : null))
      .catch((error: unknown) => {
        // 读不到就退回中性占位块(旧消息里那些指着临时目录的路径就是这种)——❌ 不弹错。
        log.warn('Failed to read attachment image', { path, error });
        return null;
      });
    return remember(promise);
  }
  const cached = attachmentDataUrlCache.get(key);
  if (cached) return cached;
  // 任务停着也一样:按附件 id 从会话那台机器的附件仓读,❌ 不经运行中的会话 —— 手机走的是同一个口。
  const promise = rpcOn(machine).sessionTimeline
    .sessionNativeAttachment({ attachmentId: id })
    .then((result) => {
      if (result.ok) return result.value;
      log.warn('ACP attachment unavailable', { id, error: result.error });
      return null;
    })
    .catch((error: unknown) => {
      log.warn('Failed to resolve ACP attachment', { id, error });
      return null;
    });
  return remember(promise);
}
