import { eq } from 'drizzle-orm';
import { LEGACY_PLACEHOLDER_PROJECT_ID } from '@main/core/folders/legacy-project-aliases';
import { db } from '@main/db/client';
import { editorBuffers } from '@main/db/schema';

function bufferId(workspaceId: string, filePath: string): string {
  return `${workspaceId}:${filePath}`;
}

export class EditorBufferService {
  async saveBuffer(workspaceId: string, filePath: string, content: string): Promise<void> {
    const id = bufferId(workspaceId, filePath);
    await db
      .insert(editorBuffers)
      // @@@c1-legacy-project — project_id is read only by the previous release after a rollback.
      .values({ id, projectId: LEGACY_PLACEHOLDER_PROJECT_ID, workspaceId, filePath, content, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: editorBuffers.id,
        set: { content, updatedAt: Date.now() },
      });
  }

  async clearBuffer(workspaceId: string, filePath: string): Promise<void> {
    await db.delete(editorBuffers).where(eq(editorBuffers.id, bufferId(workspaceId, filePath)));
  }

  async clearAllForWorkspace(workspaceId: string): Promise<void> {
    await db.delete(editorBuffers).where(eq(editorBuffers.workspaceId, workspaceId));
  }

  async listBuffers(workspaceId: string): Promise<{ filePath: string; content: string }[]> {
    return db
      .select({ filePath: editorBuffers.filePath, content: editorBuffers.content })
      .from(editorBuffers)
      .where(eq(editorBuffers.workspaceId, workspaceId));
  }
}

export const editorBufferService = new EditorBufferService();
