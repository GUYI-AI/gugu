// #6264「在哪台机器上跑」是这一条会话的属性,❌ 整页的「当前机器」。
// 项目与机器解耦:这里只管**没选项目**时的机器(那台机器的任务工作区,#609);项目选择器列的是账号下的项目,与机器无关,
// 选了项目就去项目块里开,在哪台跑由项目块的机器选择器定(project-folder-stage.tsx)。
// 须在 observer 组件里调用:机器上线/离线/改名时跟着重画(列表很短,不必 memo)。
import { useEffect, useState, type ReactElement } from 'react';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { localMachineChoice, machineChoiceFromHost, type MachineChoice } from './machine-choice';
import { MachinePicker } from './machine-picker';
import { remoteHostsStore } from './remote-hosts-store';
import { useMachineCreateContext, type MachineCreateContext } from '@renderer/features/sessions/use-machine-create-target';

/** 设备选择器里「本机」那一行的 id(本机不在 remoteHostsStore 里)。 */
const LOCAL_DEVICE = 'local';

export type NewSessionMachineTarget = { deviceId: string };

export function useNewSessionMachine(): {
  /** null = 本机。 */
  remote: NewSessionMachineTarget | null;
  machineContext: MachineCreateContext | null;
  devicePicker: ReactElement;
} {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const [remote, setRemote] = useState<NewSessionMachineTarget | null>(() => remoteHostsStore.takeNewSessionTarget());
  // 已经停在新建页时又来一次「在那台机器上新建」(设置里装好机器后的「在这台机器上新建任务」等):
  // 上面的初值只在挂载时取一次,之后来的意图在这里接住,❌ 点了之后新建页还停在原来那台机器上。
  const pendingTarget = remoteHostsStore.newSessionTarget;
  useEffect(() => {
    if (!pendingTarget) return;
    const target = remoteHostsStore.takeNewSessionTarget();
    if (target) setRemote(target);
  }, [pendingTarget]);
  // 顺序(本机 → 在线 → 离线)由选择器自己排(orderMachines),各入口同一份。
  const devices: MachineChoice[] = [
    localMachineChoice(LOCAL_DEVICE, translate('task.deviceLocal')),
    ...remoteHostsStore.pickableMachineIds().map(id => remoteChoice(id, translate)),
  ];
  const devicePicker = (
    <MachinePicker
      size="compact"
      testId="composer-device-picker"
      wakeOnPick="retry"
      machines={devices}
      selectedId={remote?.deviceId ?? LOCAL_DEVICE}
      onSelect={(deviceId) => setRemote(deviceId === LOCAL_DEVICE ? null : { deviceId })}
      onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
    />
  );
  return { remote, machineContext: useMachineCreateContext(remote), devicePicker };
}

type Translate = ReturnType<typeof useSessionMessages>['translate'];

export function remoteChoice(deviceId: string, translate: Translate): MachineChoice {
  const device = remoteHostsStore.device(deviceId);
  // 名下已经没有这台机器(被移除):照样显示它的 id、按离线画,❌ 冒充本机。
  if (!device) return { id: deviceId, label: deviceId, isLocal: false, isOnline: false };
  return machineChoiceFromHost(
    device,
    remoteHostsStore.connectionState(deviceId),
    // 通用 / 编程在这台机器上能不能开,悬停时说一句(behavior gugu-server:编程只给 SSH 装上的机器)。
    translate(device.directTerminal ? 'task.deviceHintBoth' : device.cloudComputer ? 'task.deviceHintCloudComputer' : 'task.deviceHintGeneralOnly')
  );
}
