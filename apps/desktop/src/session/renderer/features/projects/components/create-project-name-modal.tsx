import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { createGroupWithFolder, FolderMachineOfflineError } from '@renderer/features/folders/create-group-with-folder'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { createMachineSettingsHost, SettingsHostProvider } from '@renderer/features/settings/settings-host'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider'
import { Button } from '@renderer/lib/ui/button'
import { ConfirmButton } from '@renderer/lib/ui/confirm-button'
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '@renderer/lib/ui/field'
import { Input } from '@renderer/lib/ui/input'
import { safePathSegment } from '@shared/path-name'
import { log } from '@renderer/utils/logger'

type CreateProjectNameProps = BaseModalProps<string> & {
  /** #6264 文件夹建在别的机器上(那台机器的新文件夹默认位置,规则同本机)。null / 缺省 = 本机。 */
  machine?: { deviceId: string; label: string } | null
}

export const CreateProjectNameModal = observer(function CreateProjectNameModal(props: CreateProjectNameProps) {
  const { machine } = props
  if (!machine) return <CreateProjectNameForm {...props} machine={null} />
  // 新文件夹的默认位置是那台机器的设置(跟机器走的那组),读那台机器的。
  const device = remoteHostsStore.device(machine.deviceId)
  return (
    <SettingsHostProvider
      value={createMachineSettingsHost({
        deviceId: machine.deviceId,
        deviceLabel: machine.label,
        online: remoteHostsStore.connectionState(machine.deviceId) === 'connected',
        lastSeenAt: device?.lastSeenAt ?? null
      })}
    >
      <CreateProjectNameForm {...props} machine={machine} />
    </SettingsHostProvider>
  )
})

const CreateProjectNameForm = observer(function CreateProjectNameForm({
  onClose,
  onSuccess,
  machine
}: CreateProjectNameProps) {
  const { translate } = useSessionMessages()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const { settings: settingsSettings } = useAppSettingsKey('localProject')
  const settings = settingsSettings.state === 'value' ? settingsSettings.value.value : undefined
  const defaultDirectory = settings?.defaultProjectsDirectory ?? ''

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    if (!defaultDirectory) {
      setError(translate('projects.create.noDefaultDirectory'))
      return
    }
    if (safePathSegment(trimmed, '') !== trimmed) {
      setError(translate('projects.create.invalidName'))
      return
    }
    setCreating(true)
    setError(null)
    try {
      // 先建群,再在那台机器上建这个文件夹、挂进群(离线的机器不建群,直接说原因)。
      const chatId = await createGroupWithFolder({
        name: trimmed,
        machine: machine?.deviceId ?? null,
        path: `${defaultDirectory}/${trimmed}`,
        create: true,
      })
      onSuccess(chatId)
    } catch (cause) {
      log.error('[folders] creating a group with a new folder failed', { machine: machine?.deviceId ?? null, cause })
      setError(translate(cause instanceof FolderMachineOfflineError ? 'projects.create.machineOffline' : 'projects.create.failed'))
      setCreating(false)
    }
  }

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>
          {machine
            ? translate('projects.create.nameTitleOnMachine', { machine: machine.label })
            : translate('projects.create.nameTitle')}
        </DialogTitle>
      </DialogHeader>
      {/* data-testid:e2e task-projects-localization-spacing 拿这张弹窗当 locale/skin 探测面。 */}
      <DialogContentArea className="pt-0" data-testid="create-project-name-modal">
        <FieldGroup>
          <Field>
            <FieldLabel>{translate('projects.create.nameLabel')}</FieldLabel>
            <Input
              autoFocus
              value={name}
              placeholder={translate('projects.create.nameLabel')}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
            />
            {error && (
              <p
                role="alert"
                data-testid="project-creation-error"
                className="text-foreground-destructive mt-1 text-xs"
              >
                {error}
              </p>
            )}
          </Field>
        </FieldGroup>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {translate('projects.create.cancel')}
        </Button>
        <ConfirmButton disabled={!name.trim() || creating} onClick={() => void create()}>
          {translate(creating ? 'projects.create.creating' : 'projects.create.save')}
        </ConfirmButton>
      </DialogFooter>
    </>
  )
})
