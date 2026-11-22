/**
 * `remote-open-external.ts` 的生产装配:会话目录来自数据库(会话的 workspace),
 * 路由是这台机器共用的那一份(remote-pane.ts)。
 * 依赖一律用时再 import:套接字在进程起来时就开好,❌ 因为它提前拉起数据库。
 */
import fs from 'node:fs/promises';
import { answerOpenExternal, type OpenExternalDeps } from './remote-open-external';
import { sharedRemotePaneRoute } from './remote-pane';

async function sessionRoot(sessionId: string): Promise<string | null> {
  const [{ eq }, { db }, { sessions, workspaces }] = await Promise.all([
    import('drizzle-orm'),
    import('@main/db/client'),
    import('@main/db/schema'),
  ]);
  const row = db
    .select({ root: workspaces.path })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .where(eq(sessions.id, sessionId))
    .get();
  return row?.root || null;
}

export function openExternalDeps(): OpenExternalDeps {
  return {
    route: sharedRemotePaneRoute(),
    sessionRoot,
    isFile: async (path) => {
      try {
        return (await fs.stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };
}

export function answerOpenExternalCall(payload: unknown) {
  return answerOpenExternal(payload, openExternalDeps());
}
