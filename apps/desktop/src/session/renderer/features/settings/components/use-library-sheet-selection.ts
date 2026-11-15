import { useEffect, useState } from 'react';
import { useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';

/**
 * 资源库详情抽屉选中的那一家,只在资源库这一页**正显示着**时算数。
 *
 * 资源库是 retained 视图:离开它(「试试看」开新任务、左栏点「消息」)页面还挂着,抽屉连同遮罩就盖在新页面上,
 * 输入框点不到(11-07 资源库盘点实测)。离开就清掉选择:回来时也不再冒出上一次的抽屉。
 */
export function useLibrarySheetSelection(): [string | null, (id: string | null) => void] {
  const showing = useWorkspaceSlots().currentView === 'library';
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!showing) setSelected(null);
  }, [showing]);
  return [showing ? selected : null, setSelected];
}
