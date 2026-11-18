import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { remoteFailureKind } from '@gugu/session-core/session-record/contract'
import { useToast } from '@/components/toastContext'
import { messageForUser } from '@/lib/userFacingError'
import { UI_EVENTS } from '@/lib/uiEvents'
import { groupJoinDenialKey } from '@/lib/groupAgentJoin'
import './phone-new-task.css'

const CreateSessionSheet = lazy(() => import('../agent-watch/CreateSessionPage').then(module => ({ default: module.CreateSessionSheet })))

export function startPhoneNewTask(chatId: string) {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))
}

export function PhoneGroupAgentCreation({ chatId, name }: { chatId: string; name: string }) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation('messaging')
  const { t: tMain } = useTranslation('main')
  const { t: tWorkspace } = useTranslation('mobileWorkspace')
  const { toast } = useToast()

  useEffect(() => {
    const start = (event: Event) => {
      if ((event as CustomEvent<{ chatId: string }>).detail?.chatId === chatId) setOpen(true)
    }
    window.addEventListener(UI_EVENTS.createAgentInGroup, start)
    return () => window.removeEventListener(UI_EVENTS.createAgentInGroup, start)
  }, [chatId])

  return open && <Suspense fallback={null}>
    <CreateSessionSheet group={{ chatId, name }} onClose={() => setOpen(false)}
      onCreated={(device, _session, _firstPrompt, result) => {
        setOpen(false)
        const birthGroup = result?.birthGroup
        if (isPhoneDevice(device) && birthGroup?.status === 'pending_approval') toast(tWorkspace('groupJoinPending'), 'success')
        else if (birthGroup?.status === 'failed') {
          const denial = groupJoinDenialKey(birthGroup.error)
          toast(denial ? tWorkspace('groupJoinDenied') : tWorkspace('groupJoinFailed'), 'error', denial ? t(denial) : messageForUser(birthGroup.error))
        } else if (result?.startFailure) {
          toast(tMain(`agentWatch.create.failure.${remoteFailureKind(result.startFailure)}`), 'error')
        } else if (!result?.taskMessageId && (!isPhoneDevice(device) || !birthGroup)) {
          toast(t('composer.phoneTask.failed.host_outdated', { machine: device.label ?? device.hostname }), 'error')
        }
      }} />
  </Suspense>
}
