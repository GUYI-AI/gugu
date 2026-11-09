import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SharePosterDialog } from './SharePosterDialog'
import { AgentSharePopover } from './sessionpage/AgentSharePopover'
import { useToast } from './toastContext'
import { SESSIONPAGE_SHARE_ANCHOR_SELECTOR } from '../lib/sessionpageShareAnchor'
import { UI_EVENTS } from '../lib/uiEvents'
import { GUGU_ANDROID_DOWNLOAD_URL } from '../lib/appLinks'
import { useContactsStore } from '../store/contactsContext'
import { createContactQrPayload, createGuguQrScanUrl } from '@gugu/core/shared/qrPayload'

/** 会话页「分享这个 agent」:只有这里读通讯录,外壳不必因通讯录每次更新整棵重渲。 */
export function AgentShareHost() {
  const { t } = useTranslation('main')
  const { toast } = useToast()
  const { contacts, setAgentPublic } = useContactsStore()
  // 会话页分享名片:{名字, agentUserId, conversationId(留着备用,浮层本身不摆)};咕咕号**每次渲染从通讯录读**(懒分配:开启公开后才有号,
  // 存进 state 就会停在「未分配」那一帧)。非空即渲染浮层 / SharePosterDialog。
  const [shareAgentCard, setShareAgentCard] = useState<{ name: string; agentUserId: string; sessionId: string } | null>(null)
  const shareAgentContact = shareAgentCard ? contacts.find((c) => c.id === shareAgentCard.agentUserId) : undefined
  const shareAgentNumber = (() => {
    const number = shareAgentContact?.gugu_number
    return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : null
  })()
  // 名字与咕咕号同理,**每次渲染从通讯录读**:存进 state 就会停在改名前的那一帧(改名在会话页「重命名」
  // 弹窗里做,#6091)。通讯录里查不到(还没同步进来)才退回打开浮层那一刻 main 给的那个名字。
  const shareAgentName = shareAgentContact
    ? (shareAgentContact.alias?.trim() || shareAgentContact.display_name)
    : (shareAgentCard?.name ?? '')
  // 先出可复制的浮层(链接/ID 能选能复制),海报是浮层里的次级动作 —— owner:「链接没法复制,agent id 也没法复制」。
  const [shareAgentPoster, setShareAgentPoster] = useState(false)
  // @@@share-popover-dismiss 浮层钉在会话页那个分享按钮上,而不是窗口右缘 —— 每次要用的时候现查,
  // ❌ 开浮层时存下节点:会话页重渲染会换掉按钮节点,存下来的那个会脱离文档(见 AgentSharePopover 的 anchor)。
  const resolveShareAnchor = useCallback(() => document.querySelector(SESSIONPAGE_SHARE_ANCHOR_SELECTOR), [])

  // @@@sessionpage 分享 — 会话页头部点了「分享这个 agent 的名片」:main 只转达 agentUserId + 名字,咕咕号与
  // 头像从**通讯录同一份数据**取(自有 agent 就在 contacts 里),再交给既有的 SharePosterDialog 出卡片 ——
  // 与「群里点 agent 头像 → 名片 → 分享」走的是同一个组件、同一种 QR,不另做一套。
  // 无咕咕号 ≠ 不能分享:咕咕号是懒分配的(开启公开时才铸),浮层自己呈现「未分配 + 开启公开」这一态,
  // 号一到位就地变成可复制的名片(❌ 一句 toast 把人挡在外面)。
  useEffect(() => {
    const handleSessionpageShareAgent = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { agentUserId?: string; displayName?: string; sessionId?: string }
        | undefined
      if (!detail?.agentUserId) return
      const contact = contacts.find((c) => c.id === detail.agentUserId)
      const name = contact?.alias?.trim() || contact?.display_name || detail.displayName || detail.agentUserId
      setShareAgentPoster(false)
      setShareAgentCard({ name, agentUserId: detail.agentUserId, sessionId: detail.sessionId ?? '' })
    }
    // 这个会话根本没有绑定 agent(还没 provision 完 / 非会话页 provider):点了也要有反应并说清原因,
    // ❌ 让入口点下去毫无动静(owner 实机反馈「分享按钮点击没反应」)。
    const handleUnavailable = (event: Event) => {
      const reason = (event as CustomEvent).detail
      toast(typeof reason === 'string' && reason ? reason : t('shell.toast.shareUnavailable'), 'info')
    }
    window.addEventListener(UI_EVENTS.sessionpageShareAgent, handleSessionpageShareAgent)
    window.addEventListener(UI_EVENTS.sessionpageShareAgentUnavailable, handleUnavailable)
    return () => {
      window.removeEventListener(UI_EVENTS.sessionpageShareAgent, handleSessionpageShareAgent)
      window.removeEventListener(UI_EVENTS.sessionpageShareAgentUnavailable, handleUnavailable)
    }
  }, [contacts, t, toast])

  return (
    <>
        {/* @@@sessionpage 分享 — 会话页头部触发。先出浮层:咕咕号 / Agent ID / 会话 ID / 邀请链接一张表,整行点击即复制;
            「生成名片海报」才打开既有 SharePosterDialog。owner 实机反馈:直接弹海报是错的形态,海报是一张图,链接和 ID 都复制不了。
            浮层只做分享(#6093):agent 名 / ID、会话 ID 归侧栏身份卡(#6092),改名归「重命名」弹窗(#6091)。 */}
        {shareAgentCard && !shareAgentPoster && (
          <AgentSharePopover
            name={shareAgentName}
            guguNumber={shareAgentNumber}
            agentUserId={shareAgentCard.agentUserId}
            anchor={resolveShareAnchor}
            inviteUrl={shareAgentNumber === null
              ? null
              : createGuguQrScanUrl(createContactQrPayload(shareAgentNumber), { downloadUrl: GUGU_ANDROID_DOWNLOAD_URL })}
            onOpenPoster={() => setShareAgentPoster(true)}
            // 开启公开 = 铸号(set_agent_public 的一部分);通讯录随 putIdentities 更新,号在下一帧就出现在浮层里。
            onMakePublic={() => setAgentPublic(shareAgentCard.agentUserId, true)}
            onClose={() => setShareAgentCard(null)}
          />
        )}
        {shareAgentCard && shareAgentPoster && shareAgentNumber !== null && (
          <SharePosterDialog
            title={shareAgentName}
            subtitle={t('shell.shareSubtitle', { number: shareAgentNumber })}
            qrValue={createGuguQrScanUrl(createContactQrPayload(shareAgentNumber), { downloadUrl: GUGU_ANDROID_DOWNLOAD_URL })}
            onClose={() => { setShareAgentPoster(false); setShareAgentCard(null) }}
          />
        )}
    </>
  )
}
