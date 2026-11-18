// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@renderer/lib/ui/dropdown-menu';
import { useProjectPickerFolders } from './project-picker-folders';
import { ProjectPickerItem } from './project-picker-item';

vi.mock('./project-picker-folders', () => ({ useProjectPickerFolders: vi.fn() }));
vi.mock('@renderer/features/projects/stores/account-projects-store', () => ({
  accountProjectsStore: { representativeOf: () => 'local-project', localDeviceId: 'local-device' },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ sidebarStore: { rowProjectIdOf: (id: string) => id } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectStore: vi.fn(), projectDisplayName: vi.fn() }));
vi.mock('@renderer/features/projects/components/main-panel/project-folder-card', () => ({ shortHome: (path: string) => path }));
vi.mock('@renderer/features/projects/components/main-panel/project-folders', () => ({ rememberFolderChoice: vi.fn() }));
vi.mock('@renderer/features/projects/components/main-panel/project-run-machine', () => ({ carryRunMachine: vi.fn() }));
vi.mock('@renderer/features/projects/project-link-deps', () => ({ projectLinkDeps: vi.fn() }));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({ projectGroupsStore: {} }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { pickableMachineIds: () => [] } }));
vi.mock('@renderer/features/remote-hosts/machine-picker', () => ({ MachineRow: () => null }));
vi.mock('@renderer/features/remote-hosts/use-new-session-machine', () => ({ remoteChoice: vi.fn() }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

it.each([
  { reading: true, readFailed: false, label: 'projects.folders.loading' },
  { reading: false, readFailed: true, label: 'projects.picker.readFailed' },
])('opens the project folder submenu without throwing ($label)', async ({ reading, readFailed, label }) => {
  vi.mocked(useProjectPickerFolders).mockReturnValue({ folders: [], reading, readFailed });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const root = createRoot(container, { onUncaughtError: (error) => errors.push(error) });
  const project = {
    chatId: 'account-project', name: 'Example project', archived: false, activeAt: null,
    bindings: [{ deviceId: 'local-device', localProjectId: 'local-project' }],
  };
  try {
    await act(async () => root.render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Choose project</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ProjectPickerItem project={project} twin={false} onSelect={vi.fn()} />
        </DropdownMenuContent>
      </DropdownMenu>,
    ));
    const trigger = document.querySelector<HTMLElement>('[data-testid="project-picker-item"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.focus();
      trigger!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(errors).toEqual([]);
    expect(document.querySelector('[data-slot="dropdown-menu-sub-content"] [role="status"]')?.textContent).toBe(label);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
