import { ProjectCreationMenuItems } from '@renderer/features/projects/components/project-creation-menu-items';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { DropdownMenuGroup } from '@renderer/lib/ui/dropdown-menu';
import { RemoteProjectMenuItems } from './remote-project-menu-items';

/** 新建群那一组(新建群并新建文件夹 / 用现有文件夹新建群 / 使用远程文件夹),建好就进这个群。侧栏和示例(#709)用的是同一组。 */
export function AddProjectMenuItems() {
  const { navigate } = useNavigate();
  return (
    <DropdownMenuGroup>
      <ProjectCreationMenuItems onProjectReady={(chatId) => navigate('chat', { chatId })} />
      <RemoteProjectMenuItems />
    </DropdownMenuGroup>
  );
}
