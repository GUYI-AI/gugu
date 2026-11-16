import {
  asMounted,
  getProjectStore,
} from '@renderer/features/projects/stores/project-selectors';

export type ProjectGitContext = {
  repositoryWorkspaceId: string | null;
};

/** What a new task in this project starts from. */
export function useProjectGitContext(projectId: string | undefined): ProjectGitContext {
  const project = projectId ? asMounted(getProjectStore(projectId)) : undefined;
  return {
    repositoryWorkspaceId: project?.data.repositoryWorkspaceId ?? null,
  };
}
