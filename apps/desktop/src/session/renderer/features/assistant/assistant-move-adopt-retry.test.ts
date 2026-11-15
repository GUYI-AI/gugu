// @vitest-environment jsdom
// The real provision saga and the real resume store over an in-memory copy of the database's adoption rules:
// one open order per agent, and a replay of the same order is idempotent.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoveEnv } from './assistant-move-wire';

const server = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  commands: new Map<string, string>(),
  creates: 0,
  cancels: [] as string[],
  provisionCloud: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const firstOpen = (agent: unknown) => server.rows.find(row => row.existing_agent_user_id === agent && !['completed', 'cancelled'].includes(row.phase as string));
  const rpc = async (name: string, args: Record<string, never>) => {
    const row = server.rows.find(item => item.id === args.p_provision_id || item.operation_id === args.p_operation_id);
    switch (name) {
      case 'start_agent_provision_operation': {
        const member = (args.p_blueprint as { members: Record<string, unknown>[] }).members[0]!;
        const known = server.rows.some(item => item.operation_id === args.p_operation_id);
        if (known) break;
        if (firstOpen(member.existing_agent_user_id)) return { data: null, error: { message: `adopt: agent ${member.existing_agent_user_id} already has a move in flight` } };
        server.rows.push({ id: member.provision_id, operation_id: args.p_operation_id, device_id: args.p_device_id, member_key: member.member_key, owner_user_id: 'owner',
          existing_agent_user_id: member.existing_agent_user_id, agent_user_id: member.existing_agent_user_id, phase: 'queued', create_command_id: null, display_name: 'Assistant', agent_type: 'claude-code', history_import_required: false });
        break;
      }
      case 'claim_provision_slots': row!.phase = 'preparing'; return { data: [row], error: null };
      case 'prepare_agent_provision':
        if (row!.phase === 'preparing') {
          server.creates += 1;
          row!.create_command_id = `command-${server.creates}`;
          row!.dm_chat_id = 'dm';
          row!.phase = 'awaiting_terminal';
          server.commands.set(row!.create_command_id as string, 'running');
        }
        return { data: row, error: null };
      case 'settle_agent_provision_terminal': {
        const status = server.commands.get(row!.create_command_id as string);
        if (status !== 'done' && status !== 'error') return { data: null, error: { message: 'not terminal' } };
        row!.phase = status === 'done' ? 'ready' : 'failed';
        return { data: row, error: null };
      }
      case 'complete_agent_provision': row!.phase = 'completed'; return { data: [{ message_id: null, client_message_id: null, already: false }], error: null };
      case 'cancel_agent_provision_operation':
        if (server.commands.get(row!.create_command_id as string) === 'running') return { data: null, error: { message: 'adopt: the target device is still creating the new home' } };
        server.cancels.push(args.p_operation_id);
        row!.phase = 'cancelled';
        return { data: null, error: null };
      default: throw new Error(`unexpected rpc ${name}`);
    }
    return { data: { id: args.p_operation_id, phase: row?.phase === 'completed' ? 'completed' : 'provisioning_members' }, error: null };
  };
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let open = false;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      not: () => { open = true; return query; },
      maybeSingle: async () => {
        if (table !== 'agent_provisions') return { data: { id: filters[0]?.[1], phase: server.rows.find(row => row.operation_id === filters[0]?.[1])?.phase === 'completed' ? 'completed' : 'provisioning_members' }, error: null };
        const rows = server.rows.filter(row => filters.every(([key, value]) => row[key] === value)).filter(row => !open || !['completed', 'cancelled'].includes(row.phase as string));
        return { data: rows[0] ?? null, error: null };
      },
    };
    return query;
  };
  return { identityDb: { rpc, from }, getCurrentAuthUserId: async () => 'owner' };
});
vi.mock('@/lib/chat', () => ({ chatService: {
  waitForDeviceCommand: async (id: string) => {
    const status = server.commands.get(id);
    if (status === 'running') throw new Error('timed out');
    if (status === 'error') throw new Error('agent.create failed');
    return { status };
  },
  getDeviceCommand: async (id: string) => ({ status: server.commands.get(id) }),
} }));
vi.mock('@/platform', () => ({ platform: { getLocalDeviceSelfSnapshot: async () => ({ device_id: 'local', is_online: true }) } }));
vi.mock('../../../../platform', () => ({ platform: { getLocalDeviceSelfSnapshot: async () => ({ device_id: 'local', is_online: true }) } }));
vi.mock('@/lib/listDevicesOnceIdentified', () => ({ listDevicesOnceIdentified: async () => [] }));
vi.mock('@/lib/sshLinkChannel', () => ({ ensureSshMachineUsable: async () => false }));
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: async () => ({ workdir: '/assistant' }) }) }));
vi.mock('@/lib/contacts', () => ({ contactsService: { agentLookAvatarUrl: () => 'avatar' } }));
vi.mock('@/lib/identityReadAdapter', () => ({ readDisplayIdentities: vi.fn() }));
vi.mock('@/lib/agentModelSelection', () => ({ readAgentModelSelection: vi.fn(), setAgentModelSelection: vi.fn(), platformProtocolForAgentType: vi.fn() }));
vi.mock('@/lib/cloudComputerStore', () => ({ getCloudComputerState: () => ({ snapshot: { deviceId: 'cloud' } }), provisionCloudComputer: server.provisionCloud, refreshCloudComputer: vi.fn(), wakeCloudComputer: vi.fn() }));
vi.mock('@/lib/myAssistant', () => ({ reloadMyAssistant: vi.fn() }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { connectionState: () => 'connected' } }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: vi.fn() }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));
vi.mock('./assistant-machine', () => ({ openAssistantMachine: vi.fn() }));

import { refreshCloudComputer } from '@/lib/cloudComputerStore';
import { assistantResumeStore } from '@/lib/assistantSetup';
import { buildMoveDeps } from './assistant-move-wire';
import type { MoveSide } from './assistant-move';

const env = { ownerUserId: 'owner', assistantId: 'agent', assistantName: 'Assistant', localDeviceId: 'local', home: { kind: 'cloud', deviceId: 'cloud' } } as MoveEnv;
const adoptHere = () => buildMoveDeps(env, 'to-computer', {} as MoveSide, { kind: 'cloud', deviceId: 'cloud' }).adopt();
const openRow = () => server.rows.filter(row => !['completed', 'cancelled'].includes(row.phase as string));

beforeEach(() => {
  localStorage.clear();
  server.rows = [];
  server.commands = new Map();
  server.creates = 0;
  server.cancels = [];
  server.provisionCloud.mockReset();
});

describe('retrying an adoption that has not finished', () => {
  it('joins the running order, sends no second create, and finishes once that create ends', async () => {
    await expect(adoptHere()).rejects.toThrow('still starting');
    const [{ operation_id: first }] = server.rows as { operation_id: string }[];
    await expect(adoptHere()).rejects.toThrow('still starting');
    expect(server.rows).toHaveLength(1);
    expect(server.creates).toBe(1);
    server.commands.set('command-1', 'done');
    await expect(adoptHere()).resolves.toBeUndefined();
    expect(server.rows).toHaveLength(1);
    expect(server.rows[0]).toMatchObject({ operation_id: first, phase: 'completed' });
    expect(assistantResumeStore.list('owner')).toEqual([]);
  });
  it('retries a failed create on the same order', async () => {
    await expect(adoptHere()).rejects.toThrow('still starting');
    server.commands.set('command-1', 'error');
    await expect(adoptHere()).rejects.toThrow('adopt failed');
    await expect(adoptHere()).rejects.toThrow('still starting');
    expect(server.rows).toHaveLength(1);
    expect(server.creates).toBe(2);
    server.commands.set('command-2', 'done');
    await expect(adoptHere()).resolves.toBeUndefined();
    expect(server.rows[0]).toMatchObject({ phase: 'completed' });
  });
  it('cancels an order this client cannot drive, then starts a new one', async () => {
    await expect(adoptHere()).rejects.toThrow('still starting');
    server.commands.set('command-1', 'error');
    localStorage.clear();
    await expect(adoptHere()).rejects.toThrow('still starting');
    expect(server.cancels).toHaveLength(1);
    expect(server.rows.map(row => row.phase)).toEqual(['cancelled', 'awaiting_terminal']);
  });
  it('leaves an order this client cannot drive alone while its create is running', async () => {
    await expect(adoptHere()).rejects.toThrow('still starting');
    localStorage.clear();
    await expect(adoptHere()).rejects.toThrow('still creating');
    expect(server.rows).toHaveLength(1);
    expect(server.creates).toBe(1);
    expect(openRow()).toHaveLength(1);
  });
  it('cancels an order aimed at another home, then starts one here', async () => {
    server.rows.push({ id: 'other', operation_id: 'other-op', device_id: 'elsewhere', member_key: 'assistant', owner_user_id: 'owner', existing_agent_user_id: 'agent', phase: 'failed', create_command_id: 'old' });
    server.commands.set('old', 'error');
    await expect(adoptHere()).rejects.toThrow('still starting');
    expect(server.cancels).toEqual(['other-op']);
    expect(openRow()).toMatchObject([{ device_id: 'local' }]);
  });
});

describe('moving to the cloud while another order is open', () => {
  const toCloud = () => buildMoveDeps(env, 'to-cloud', {} as MoveSide, { kind: 'computer', deviceId: 'local' }).adopt();
  const open = (device: string, status: string) => {
    server.rows.push({ id: 'open', operation_id: 'open-op', device_id: device, member_key: 'assistant', owner_user_id: 'owner', existing_agent_user_id: 'agent', phase: 'failed', create_command_id: 'old' });
    server.commands.set('old', status);
    server.provisionCloud.mockRejectedValue(new Error('stop after the order check'));
    vi.mocked(refreshCloudComputer).mockResolvedValue({ state: 'awake', deviceId: 'cloud' } as never);
  };
  it('cancels an order aimed at a computer', async () => {
    open('elsewhere', 'error');
    await expect(toCloud()).rejects.toThrow('stop after the order check');
    expect(server.cancels).toEqual(['open-op']);
  });
  it('stops without calling the manager while that order is still creating', async () => {
    open('elsewhere', 'running');
    await expect(toCloud()).rejects.toThrow('still creating');
    expect(server.provisionCloud).not.toHaveBeenCalled();
  });
  it('cancels an order aimed at a computer when no cloud home exists', async () => {
    open('elsewhere', 'error');
    vi.mocked(refreshCloudComputer).mockResolvedValue({ state: 'none', deviceId: null } as never);
    await expect(toCloud()).rejects.toThrow('stop after the order check');
    expect(server.cancels).toEqual(['open-op']);
  });
  it.each([
    ['the cloud state cannot be read', null],
    ['the cloud home has no device id yet', { state: 'provisioning', deviceId: null }],
  ])('cancels nothing while %s', async (_name, snapshot) => {
    open('cloud', 'error');
    vi.mocked(refreshCloudComputer).mockResolvedValue(snapshot as never);
    await expect(toCloud()).rejects.toThrow('stop after the order check');
    expect(server.cancels).toEqual([]);
    expect(server.provisionCloud).toHaveBeenCalled();
  });
  it('leaves the manager\'s own order for the manager to retry', async () => {
    open('cloud', 'error');
    await expect(toCloud()).rejects.toThrow('stop after the order check');
    expect(server.cancels).toEqual([]);
    expect(server.provisionCloud).toHaveBeenCalled();
  });
});

describe('an adoption that switched homes but missed its last step', () => {
  const landed = () => {
    server.rows.push({ id: 'landed', operation_id: 'landed-op', device_id: 'local', member_key: 'assistant', owner_user_id: 'owner', existing_agent_user_id: 'agent', phase: 'ready', create_command_id: 'old' });
    server.commands.set('old', 'done');
  };
  it('does not block the next move back here', async () => {
    landed();
    await expect(adoptHere()).rejects.toThrow('still starting');
    expect(server.rows.map(row => row.phase)).toEqual(['completed', 'awaiting_terminal']);
    expect(server.cancels).toEqual([]);
  });
  it('does not block the next move to the cloud', async () => {
    landed();
    server.provisionCloud.mockRejectedValue(new Error('stop after the order check'));
    await expect(buildMoveDeps(env, 'to-cloud', {} as MoveSide, { kind: 'computer', deviceId: 'local' }).adopt()).rejects.toThrow('stop after the order check');
    expect(server.rows[0]).toMatchObject({ phase: 'completed' });
  });
});
