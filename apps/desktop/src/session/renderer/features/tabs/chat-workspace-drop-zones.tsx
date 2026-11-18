import { useDroppable } from '@dnd-kit/core';
import { observer } from 'mobx-react-lite';
import { cn } from '@renderer/utils/utils';
import { chatToolDropId, type ChatToolSide } from './chat-tool-geometry';
import type { PaneLayoutStore } from './pane-layout-store';

export const ChatWorkspaceDropZones = observer(function ChatWorkspaceDropZones({
  layout,
}: { layout: PaneLayoutStore }) {
  const panes = layout.chatWorkspacePanes;
  if (!panes?.tools) return null;
  const tools = panes.tools.paneId;
  const chat = panes.chat.paneId;
  const toolShare = layout.paneSizes[layout.chatToolSide === 'left' ? 0 : 1];
  const toolWidth = `clamp(${layout.paneMinWidth(tools)}px, ${toolShare}%, calc(100% - ${layout.paneMinWidth(chat) + 1}px))`;
  return (
    <div className="pointer-events-none absolute inset-0 z-30" data-chat-tool-drop-zones="">
      {(['left', 'right'] as const).map((side) => (
        <ChatWorkspaceDropZone key={side} chatPaneId={chat} side={side} toolWidth={toolWidth} />
      ))}
    </div>
  );
});

function ChatWorkspaceDropZone({ chatPaneId, side, toolWidth }: {
  chatPaneId: string;
  side: ChatToolSide;
  toolWidth: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: chatToolDropId(side, chatPaneId) });
  const edge = cn('absolute inset-y-0', side === 'left' ? 'left-0' : 'right-0');
  return <>
    <div ref={setNodeRef} className={cn(edge, 'w-2/5')} data-chat-tool-drop-edge={side} />
    {isOver && <div className={cn(edge, 'rounded-md border border-foreground-info/25 bg-foreground-info/10')}
      style={{ width: toolWidth }} data-chat-tool-drop-preview={side} />}
  </>;
}
