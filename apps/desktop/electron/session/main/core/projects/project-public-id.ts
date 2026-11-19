import type { ProjectGroupBinding } from '@shared/core/projects/project-groups';

/**
 * @@@project-public-id - the one boundary between an agent's project id and this machine's local projects.
 *
 * A project is account-level and its id is its project group chat id; agents write it `project:<chat_id>`. A local
 * project id only names "this machine's folder binding" and never leaves the machine. Every host translates at its
 * own boundary with these two functions:
 * - inward: chat id -> the local projects bound to it here and recorded on the account (several when another project's
 *   root joined the group; the first is the one new folders, sessions and published files go to);
 * - outward: local project -> its chat id, or null for a local project in no project group (no outward id).
 * A local id passed in is refused, naming the right `project:<chat_id>`: there is no second path where it still works.
 */
type Deps = {
  bindings(): Promise<readonly ProjectGroupBinding[]>;
  get(id: string): Promise<{ name: string } | undefined>;
};

/** Local projects of `id` on this machine: [] when this machine has no folder for that project. */
export async function localProjectsOf(id: string, deps: Deps): Promise<string[]> {
  const bindings = await deps.bindings();
  const bound = bindings.filter((binding) => binding.chatId === id).map((binding) => binding.projectId);
  if (bound.length) return bound;
  const local = await deps.get(id);
  if (!local) return [];
  const chatId = bindings.find((binding) => binding.projectId === id)?.chatId;
  throw new Error(chatId
    ? `project:${id} is this device's local id for "${local.name}", not a project id; use project:${chatId}`
    : `project:${id} is this device's local folder record "${local.name}", which is in no project; add its folder to a project with project_add_folder`);
}

/** The local project new work for `id` goes to on this machine; fails when this machine has no folder for it. */
export async function localProjectOf(id: string, deps: Deps): Promise<string> {
  const [primary] = await localProjectsOf(id, deps);
  if (!primary) throw new Error(`This device has no folder for project:${id}. Link one with project_add_device`);
  return primary;
}

/** local project id -> its outward project id (chat id), or null when it is in no project group. */
export function outwardProjectIds(bindings: readonly ProjectGroupBinding[]): (localId: string) => string | null {
  const byProject = new Map(bindings.map((binding) => [binding.projectId, binding.chatId]));
  return (localId) => byProject.get(localId) ?? null;
}

/** Inward: only the bindings this machine records on the account (no workspace's or hidden project's leftover binding). */
async function machineDeps(): Promise<Deps> {
  const [{ recordedProjectGroupBindings }, { getProjectById }] = await Promise.all([import('./operations/device-project-records'), import('./operations/getProjects')]);
  return { bindings: recordedProjectGroupBindings, get: getProjectById };
}

/** This machine's bindings, read once for a batch of outward ids. */
export async function machineOutwardProjectIds(): Promise<(localId: string) => string | null> {
  const { listProjectGroupBindings } = await import('./operations/project-groups');
  const read = await listProjectGroupBindings();
  if (!read.success) throw new Error(read.error.message);
  return outwardProjectIds(read.data);
}

export async function machineLocalProjectsOf(id: string): Promise<string[]> {
  return localProjectsOf(id, await machineDeps());
}

export async function machineLocalProjectOf(id: string): Promise<string> {
  return localProjectOf(id, await machineDeps());
}
