// #113 开机清掉旧缓存;手机上离线机器的项目照账号上那份列全。
import { describe, expect, it, vi } from 'vitest';
import type { Device } from '@gugu/core/shared/types/chat';
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject';
import { deviceSessionsOf } from '@/session/shared/remote-sessions/session-directory';
import { forgetRetiredProjectCaches } from './account-projects';

const record = (overrides: Partial<DeviceProject> = {}): DeviceProject => ({
  localProjectId: 'proj-repo-1',
  name: 'repo',
  rootPath: '/srv/repo',
  createdAt: '2026-10-01T08:00:00.000Z',
  chatId: 'chat-repo',
  folders: [
    { workspaceId: 'ws-root', kind: 'root', path: '/srv/repo', attachedAt: null },
    { workspaceId: 'ws-wt', kind: 'attached', path: '/srv/repo-wt', attachedAt: '2026-10-02T00:00:00.000Z' },
  ],
  ...overrides,
});

describe('retired caches', () => {
  it('开机清掉每台桌面从前各记一份的那几样', () => {
    const removeItem = vi.fn();
    forgetRetiredProjectCaches({ removeItem });
    expect(removeItem.mock.calls.map(([key]) => key)).toEqual([
      'gugu:machine-projects:v1',
      'gugu:machine-home-dirs:v1',
      'gugu.projectGroups.v1',
      'gugu.projectFolders.v1',
      'gugu:remote-recent-folders:v1',
      'gugu.projectDeviceScope.v1',
    ]);
  });
});

describe('手机:离线机器上的项目照账号上那份列全', () => {
  const device = (overrides: Partial<Device> = {}): Device => ({
    device_id: 'dev-1',
    label: 'd22',
    hostname: 'd22',
    platform: 'linux',
    status: 'offline',
    last_seen_at: '2026-10-22T00:00:00Z',
    is_online: false,
    capabilities: { terminals: [], runtimes: [] },
    session_digest: [{
      conversationId: 's1', projectId: 'proj-digest-only', projectName: 'scratch', title: 't', harness: 'codex', agentStatus: null,
      lastInteractedAt: null, supported: true,
    }] as Device['session_digest'],
    ...overrides,
  });

  it('没有会话的项目也列出来;摘要里的会话所在的项目照样有归处', () => {
    const sessions = deviceSessionsOf(device({ projects: [record()] }), {});
    expect(sessions.projects).toEqual([
      { id: 'proj-repo-1', name: 'repo', path: '/srv/repo' },
      { id: 'proj-digest-only', name: 'scratch', path: '' },
    ]);
    expect(sessions.sessions.map((session) => session.conversationId)).toEqual(['s1']);
  });

  it('还没读到账号上那份:照旧只有摘要里的', () => {
    expect(deviceSessionsOf(device(), {}).projects).toEqual([{ id: 'proj-digest-only', name: 'scratch', path: '' }]);
  });
});
