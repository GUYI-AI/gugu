import { observer } from 'mobx-react-lite';
import { SessionChatTimeline } from '../view/session-chat-timeline';
import { AcpChatPanel } from './acp-chat-panel';
import { DesktopLiveWindowConversation } from '../../live-window/DesktopLiveWindowConversation';

export const TabContent = observer(function AcpChatTabContent() {
  // 时间线刻度常驻对话左缘(#4874);原来画在聊天栏外框上,对话变成页签后跟着对话本身走(#7052)。
  return (
    <DesktopLiveWindowConversation kind="acp-chat"><SessionChatTimeline>
      <AcpChatPanel />
    </SessionChatTimeline></DesktopLiveWindowConversation>
  );
});
