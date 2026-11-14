import { describe, expect, it, vi } from 'vitest';
import { linkProjectDevice } from './project-device-link';

describe('project device linking', () => {
  it('prepares the source and binds only on the selected target, preserving undo routing', async () => {
    const onDevice = vi.fn().mockResolvedValueOnce({ project_id: 'group', chat_id: 'group', name: 'App' }).mockResolvedValueOnce({ project_id: 'group', undo: { tool: 'project_remove_device', project_id: 'group', path: '/remote/app' } });
    const result = await linkProjectDevice({ project_id: 'group', device: 'a', target_device: 'b', path: '/remote/app' }, onDevice);
    expect(onDevice.mock.calls).toEqual([
      ['a', { action: 'project_prepare_device', project_id: 'group' }],
      ['b', { action: 'project_bind_folder', chat_id: 'group', name: 'App', path: '/remote/app', merge_existing: undefined }],
    ]);
    // One project id on both devices: the result names no local project of either.
    expect(result).toEqual({ project_id: 'group', name: 'App', device_id: 'b', undo: { tool: 'project_remove_device', project_id: 'group', path: '/remote/app', device_id: 'b' } });
  });
  it('propagates the target’s merge confirmation without reporting a successful link', async () => {
    const onDevice = vi.fn().mockResolvedValueOnce({ project_id: 'source', chat_id: 'group', name: 'App' }).mockResolvedValueOnce({ needs_confirmation: true, project_id: 'group', source_name: 'Old', sessions: 3 });
    expect(await linkProjectDevice({ target_device: 'b', path: '/remote/app' }, onDevice)).toMatchObject({ needs_confirmation: true, project_id: 'source', source_name: 'Old', sessions: 3 });
  });
  it('stops when the source cannot answer; the target remains untouched', async () => {
    const onDevice = vi.fn().mockRejectedValue(new Error('source offline'));
    await expect(linkProjectDevice({ target_device: 'b', path: '/remote/app' }, onDevice)).rejects.toThrow('source offline');
    expect(onDevice).toHaveBeenCalledOnce();
  });
});
