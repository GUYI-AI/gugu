import {
  asMounted,
  getProjectStore,
} from '@renderer/features/projects/stores/project-selectors';

export type ProjectGitContext = {
  repositoryWorkspaceId: string | null;
};

/**
 * What a new task in this project starts from. (The root's head — branch, unborn — was read here once and passed down,
 * but nothing drew or decided on it: it is no longer read.)
 */
export function useProjectGitContext(projectId: string | undefined): ProjectGitContext {
  const project = projectId ? asMounted(getProjectStore(projectId)) : undefined;
  return {
    repositoryWorkspaceId: project?.data.repositoryWorkspaceId ?? null,
  };
}
