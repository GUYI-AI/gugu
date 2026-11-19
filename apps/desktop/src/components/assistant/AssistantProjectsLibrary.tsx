import { PhoneProjects } from '../../mobile/assistant/PhoneProjects'
import { platform } from '../../platform'
import { revealSessionpage } from '../../hooks/useSessionpageReveal'
import { openChatOnScreen } from '../../session/renderer/features/chats/open-chat'
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core'

type Props = { machine: AssistantMachine | null | undefined; onOpen?: () => void; askInChat?: (text: string) => void }

/** The groups with folders on my machines: on the desktop a row opens the group, on the phone it lists the group's folders. */
const openGroup = platform.capabilities.agentRuntime ? (chatId: string) => { openChatOnScreen(chatId, false); revealSessionpage() } : undefined

export function AssistantProjectsCard(props: Props) {
  return <PhoneProjects {...props} onOpenGroup={openGroup} />
}
export function AssistantProjectsLibrary(props: Props) {
  return <PhoneProjects {...props} detail onOpenGroup={openGroup} />
}
