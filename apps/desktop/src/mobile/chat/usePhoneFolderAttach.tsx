import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { PaneBackButton } from '@/components/contacts/ContactDetail'
import { RemoteFolderPicker } from '@/components/RemoteFolderPicker'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { useBackLayer } from '@/components/ui/sheetStack'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { rendererLogger } from '@/lib/log'
import { notify } from '@/lib/notices'
import { shortHome } from '@/session/shared/path-name'
import { navigateMobile } from '@/mobile/navigateMobile'
import { visibleMachines, workspaceDevices } from '@/components/session-watch/machine-list'
import { useMachineLabel } from '@/components/session-watch/useMachineLabel'
import { readChatSummary } from '@/lib/chatSummariesBridge'
import { projectRpcOn } from '../partners/projectRpc'
import { folderCardMachine, type ChatTaskFolders, type TaskFolderHome } from './phoneTaskFolders'
import { MAX_GROUP_FOLDERS } from '@/session/renderer/features/folders/group-folders'
import { groupFoldersStore, type GroupFolder } from '@/session/renderer/features/folders/group-folders-store'

const log = rendererLogger('phone-folder-attach')
type Added = { folder: GroupFolder; home: TaskFolderHome }

/** 挂文件夹:机器清单、那台机器的目录树;卡片自身提供机器菜单。挂在别的群里的,问过才挪到这个群。 */
export function usePhoneFolderAttach(project: ChatTaskFolders | null, devices: Device[], refresh: () => Promise<void>) {
  const { t } = useTranslation('messaging')
  const { translate: st } = useSessionMessages()
  const { isHome, label } = useMachineLabel()
  const machines = visibleMachines(workspaceDevices(devices), isHome)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [added, setAdded] = useState<Added[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [merge, setMerge] = useState<{ name: string; answer: (yes: boolean) => void } | null>(null)
  const mergeRef = useRef(merge)
  mergeRef.current = merge
  useEffect(() => {
    setAdded([]); setDeviceId(null)
    return () => { mergeRef.current?.answer(false) }
  }, [project?.chatId])
  const close = () => { if (!busy) navigateMobile(() => setDeviceId(null), 'pop') }
  useBackLayer(close, !!deviceId)
  const device = devices.find((row) => row.device_id === deviceId)
  const attach = async (path: string) => {
    if (!project || !device || busy) return
    setBusy(true); setError(false)
    try {
      const rpc = projectRpcOn(device)
      let bound = await rpc.folders.bindFolderAtPath({ path, chatId: project.chatId })
      if (!bound.success && bound.error.type === 'bound-elsewhere') {
        const other = readChatSummary(bound.error.chatId)?.name ?? ''
        const yes = await new Promise<boolean>((answer) => setMerge({ name: other, answer: (agreed) => { setMerge(null); answer(agreed) } }))
        if (!yes) return
        bound = await rpc.folders.bindFolderAtPath({ path, chatId: project.chatId, move: true })
      }
      if (!bound.success) throw new Error(bound.error.type)
      const folder = bound.data
      if (folder) {
        const shown: GroupFolder = { id: folder.id, path: folder.path, chatId: project.chatId, deviceId: device.device_id, sort: folder.sort ?? 0,
          gitless: folder.gitless, branch: folder.branch, sessionIds: folder.sessionIds, attachedAt: folder.attachedAt ?? new Date().toISOString(), offline: false }
        setAdded((current) => [...current.filter((item) => item.folder.id !== folder.id), {
          folder: shown,
          home: { deviceId: device.device_id, folderId: folder.id, machine: { ...folderCardMachine(device, label), online: true } },
        }])
        notify({ title: st('projects.folders.attachedOn', { machine: label(device), path: shortHome(folder.path), projectName: project.name }), duration: 8000,
          action: { label: st('projects.folders.undo'), onClick: () => {
            void rpc.folders.unbindFolder(folder.id).then(async (undone) => {
              if (!undone.success) { notify({ tier: 'error', title: t('composer.phoneTask.attachFailed') }); return }
              setAdded((current) => current.filter((item) => item.folder.id !== folder.id))
              await refresh()
              notify({ title: st('projects.folders.detached', { path: shortHome(folder.path), projectName: project.name }) })
            }).catch((cause) => { log.warn({ error: String(cause) }, 'undo folder attachment failed'); notify({ tier: 'error', title: t('composer.phoneTask.attachFailed') }) })
          } },
        })
        await refresh()
        void groupFoldersStore.refresh()
        navigateMobile(() => setDeviceId(null), 'pop')
      }
    } catch (cause) { log.warn({ error: String(cause), deviceId }, 'binding a folder to the group failed'); setError(true) }
    finally { setBusy(false) }
  }
  const root = document.querySelector('[data-phone-shell]')
  const picker = device && root ? createPortal(
    <div className="gg-phone-folder-picker" data-testid="phone-task-attach-folder">
      <Pane paneRole="detail" mobile className="gg-partners">
        <PaneHeader mobile leading={<PaneBackButton label={t('common.cancel')} onBack={close} />} title={t('composer.phoneTask.attachFolder')} />
        {error ? <p role="alert" className="gg-partners-error">{t('composer.phoneTask.attachFailed')}</p> : null}
        <div className="gg-partners-picker" inert={busy}>
          <RemoteFolderPicker deviceId={device.device_id} initialPath="~" onSelect={(path) => void attach(path)} onCancel={close} />
        </div>
      </Pane>
      <Dialog.Root open={!!merge} onOpenChange={(open) => { if (!open) merge?.answer(false) }}>
        <Dialog.Portal><Dialog.Backdrop /><Dialog.Viewport><Dialog.Popup>
          <Dialog.Title>{st('projects.folders.errorOtherProject', { projectName: merge?.name ?? '' })}</Dialog.Title>
          <Dialog.Description>{st('projects.folders.moveDescription', { projectName: project?.name ?? '' })}</Dialog.Description>
          <Button variant="ghost" onClick={() => merge?.answer(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => merge?.answer(true)}>{st('projects.folders.moveConfirm')}</Button>
        </Dialog.Popup></Dialog.Viewport></Dialog.Portal>
      </Dialog.Root>
    </div>, root,
  ) : null
  return {
    added, picker,
    remove: (folderId: string) => setAdded((current) => current.filter((item) => item.folder.id !== folderId)),
    fresh: added.at(-1)?.folder.id,
    attachMachines: machines.map((row) => folderCardMachine(row, label)),
    onAttach: (id: string | null) => {
      // 挂满了就当场说,❌ 先推目录页、挑完才拒(同电脑 #629;各台机器合计,含这一页刚挂上的)。
      const count = new Set([...(project?.folders ?? []), ...added.map((item) => item.folder)].map((folder) => folder.id)).size
      if (project && count >= MAX_GROUP_FOLDERS) {
        notify({ tier: 'error', title: st('projects.folders.errorFull', { projectName: project.name, max: MAX_GROUP_FOLDERS }) })
        return
      }
      setError(false); navigateMobile(() => setDeviceId(id), 'push')
    },
  }
}
