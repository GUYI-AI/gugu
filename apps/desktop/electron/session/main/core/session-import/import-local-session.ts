import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { KeyedMutex } from '@gugu/session-core/lib';
import { NEW_SESSION_PERMISSION_MODE } from '@gugu/session-core/acp';
import { rootFolderOf } from '@main/core/folders/folders';
import { workspaceAtDirectory } from '@main/core/workspaces/workspace-at-directory';
import { sessionService } from '@main/core/sessions/session-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import {
  LOCAL_SESSION_ENGINE_PROVIDER,
  type ImportLocalSessionParams,
  type ImportLocalSessionResult,
  type LocalSessionEngine,
  type LocalSessionPreview,
} from '@shared/core/session-import/session-import';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';
import { getLocalSessionSource } from './host-source';

// @@@sessionpage 导入本机已有会话 (spec session-page-import)。
//
// 「导入」不是把历史抄一份进来，而是把那条会话本身接进会话页：新建的 conversation 绑定
// provider 自己的 session id，第一次启动就走 resume，上下文仍在 provider 那边的原件里。
// 两个引擎的恢复机制不同，这里的 id 分配也就不同：
//   · claude 的 CLI 用会话页的 conversation.id 当会话号（`--resume <conversation.id>`），
//     所以 conversation.id 直接取原会话的 UUID；
//   · codex 声明了 `sessions.resumeNeedsProviderId`(续跑只认原生 id),用 conversation.sessionId
//     （`codex resume <sessionId>`），conversation.id 照常随机。
// 见 core/sessions/resolve-agent-session-command.ts。
//
// 会话跑在**原会话的工作目录**，不另开 worktree（repo-root preset）—— 换个目录 resume，
// 原会话里那些文件路径就全指错地方了。

/** claude 的 CLI 拿 conversation.id 当会话号，所以导入时直接用原会话 id 建 conversation。 */
function sessionIdFor(engine: LocalSessionEngine, providerSessionId: string): string {
  return engine === 'claude-code' ? providerSessionId : randomUUID();
}

/**
 * 这条会话的落点：原目录本身的工作区（记录过的文件夹、文件夹里的目录，或者一个新的、不挂群的文件夹）。
 *
 * 关键是**会话必须在它原来的目录里跑起来**：claude 按「会话所在目录」定位会话
 * （`~/.claude/projects/<转义 cwd>`），归一化到仓库根会让 `--resume` 直接找不到原会话。
 * 它所在文件夹挂着群，会话就开在那个群里；没有群就是一条没有群的会话。
 */
function resolveImportWorkspace(workingDirectory: string): { workspaceId: string; groupChatId: string | null } {
  let workspaceId: string;
  try {
    workspaceId = workspaceAtDirectory(workingDirectory);
  } catch (error) {
    throw new Error(`这条会话所在的目录已经不在了或读不到：${workingDirectory}（${error instanceof Error ? error.message : String(error)}）`);
  }
  const folder = rootFolderOf(workspaceId);
  if (!folder) throw new Error(`${workingDirectory} 不在这台电脑记录的文件夹里`);
  return { workspaceId, groupChatId: folder.chatId };
}

// The database-owning host claims one native session at a time; other native sessions stay independent.
const importClaims = new KeyedMutex();

export async function importLocalSession(
  params: ImportLocalSessionParams
): Promise<ImportLocalSessionResult> {
  // 渲染层传来的 filePath 不可信，也可能来自上一轮缓存、文件早被删了。
  // 走宿主的解析器复核一遍：它同时把路径钉在允许的扫描目录内，并给出原件里的权威 sessionId/cwd。
  const preview = await getLocalSessionSource().preview({
    filePath: params.filePath,
    engine: params.engine,
  });

  return bindLocalSession(params, preview);
}

/** Host-only binding after a source reader has validated the native metadata. Never accepts an RPC preview. */
export async function bindLocalSession(
  params: ImportLocalSessionParams,
  preview: Pick<LocalSessionPreview, 'providerSessionId' | 'title' | 'cwd'>,
): Promise<ImportLocalSessionResult> {
  const providerSessionId = preview.providerSessionId.trim();
  if (!providerSessionId) {
    throw new Error('这条会话没有可用的会话 id，无法恢复原会话');
  }
  const workingDirectory = preview.cwd?.trim();
  if (!workingDirectory) {
    throw new Error('读不出这条会话的工作目录，导入后无法在原位置继续');
  }

  const provider = LOCAL_SESSION_ENGINE_PROVIDER[params.engine];
  // 终端腿 `--resume`、聊天腿 `session/load`,续的都是同一个 provider 会话 id(见 switch-session-runtime)。
  const runtime = params.sessionView === 'code' ? 'pty' : 'acp';

  return importClaims.runExclusive(JSON.stringify([provider, providerSessionId]), async () => {
    // 同一条会话只接进来一次：再次导入直接回到已有的那个会话，不建重复的。
    const [existing] = await db
      .select({
        id: sessions.id,
      })
      .from(sessions)
      .where(and(
        eq(sessions.provider, provider),
        eq(sessions.providerSessionId, providerSessionId),
      ))
      .limit(1);
    if (existing) {
      return {
        sessionId: existing.id,
        workingDirectory,
        alreadyImported: true,
      };
    }

    const { workspaceId, groupChatId } = resolveImportWorkspace(workingDirectory);

    const sessionId = sessionIdFor(params.engine, providerSessionId);
    const title = preview.title.trim() || params.title.trim() || '导入的会话';

    const created = await sessionService.createSession({
      ...(groupChatId ? { groupChatId } : {}),
      sessionConfig: {
        version: '1',
        name: title,
        initialSession: {
          id: sessionId,
          provider,
          // The engine's own title is the name the person knows this session by.
          title,
          // 导入是另一个动词:历史本来就在引擎那边，咕咕只是把它认领进来 ——
          // 带上 provider 自己的会话 id，第一次启动就 resume 它而不是开新的。
          origin: { kind: 'import', providerSessionId: providerSessionId },
          type: runtime,
          // 档位显式写进记录:缺席时终端腿会退回「不加旗标」= harness 自己挑档(#7366)。与新建缺省同一个答案。
          permissionMode: NEW_SESSION_PERMISSION_MODE,
        },
      },
      workspaceConfig: buildWorkspaceConfigFromPreset('repo-root', { repositoryWorkspaceId: workspaceId }),
    });
    if (!created.success) {
      // ❌ 别在这里再写一次「导入失败：」——界面已经带了这个前缀，重复一遍只是噪音。
      throw new Error(`没能建出这条会话（${created.error.type}）`);
    }

    return {
      sessionId,
      workingDirectory,
      alreadyImported: false,
    };
  });
}
