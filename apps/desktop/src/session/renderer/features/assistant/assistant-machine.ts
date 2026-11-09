// #7199 桌面:在它家那台的任务工作区里读写助理目录，不把目录登记为项目。
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { rpcOn } from '@renderer/lib/ipc';
import { ensureImplicitSessionHomeProjectId } from '@renderer/features/sessions/implicit-session-home-project';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { homeTarget } from './assistant-home-sessions';
import { openMachineWith, type AssistantMachine } from './assistant-machine-core';

export * from './assistant-machine-core';

/** Reuse the machine's task workspace; keep the assistant's real directory as a file capability. */
export async function openAssistantMachine(home: AssistantHomePlace, workdir: string): Promise<AssistantMachine> {
  const target = homeTarget(home);
  const rpc = rpcOn(target);
  const projectId = target === null ? await ensureImplicitSessionHomeProjectId() : await remoteHostsStore.ensureTaskWorkspace(home.deviceId, true);
  if (!projectId) throw new Error('Task workspace is unavailable');
  const homeDir = target === null ? await rpc.app.getHomeDirectory() : await remoteHostsStore.ensureHomeDir(home.deviceId);
  // 住云上:说明、记忆、技能在 ~/.claude,资料在 ~/给助理的资料,都不在它的工作目录里 —— 工作区要圈住整个主目录,
  // 否则往云上拷这些(分块写、建夹)会被「只能写工作区里的」挡下(搬家 #2104 真机)。住电脑上的都在工作目录里。
  const acquired = await rpc.projects.acquireTaskDirectory(projectId, home.kind === 'cloud' ? homeDir : workdir);
  if (!acquired.success) throw new Error(`Could not open the assistant directory: ${acquired.error.type}`);
  return { ...(await openMachineWith(rpc, { deviceId: home.deviceId, projectId, workspaceId: acquired.data.workspaceId, home: homeDir, workdir, kind: home.kind })), target };
}
