import { defineEvent } from '@shared/lib/ipc/events';
import type { ProjectionHostPacket } from '@shared/extensions/projection-protocol';
import type { TaskPageState } from '@shared/browser-task-page';

export const liveWindowPacketChannel = defineEvent<{ watchId: string; packet: ProjectionHostPacket }>('live-window:packet');
export const liveWindowPageStateChannel = defineEvent<{ watchId: string; state: TaskPageState }>('live-window:page-state');
export const liveWindowSourcesChannel = defineEvent<{ watchId: string; sessionId: string }>('live-window:sources');
