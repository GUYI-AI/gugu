import type { ReactNode } from 'react'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives'
import { Button } from '@renderer/lib/ui/button'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@renderer/lib/ui/select'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import './connection-settings.css'

/**
 * 一家的「连接」:当前连接(带这一家的状态那一行)与添加连接。订阅页那一行与资源库详情画的都是这一块,
 * 同一份读数、同一组按钮(owner 2026-11-12:「你非得每个都不一样干嘛」)。
 */
export function ConnectionSettingsRows({
  agentId,
  connections,
  open,
  onOpenChange,
  onSelect,
  onAdd,
  addHint,
  busy,
  description,
  notice,
  signIn,
  unreadable = false,
  embedded = false,
  children,
  form
}: {
  agentId: string
  /** 只列真有东西的连接;undefined = 还在读。 */
  connections: HarnessConnection[] | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
  /** 缺席 = 这家此刻没有能加的方式:「添加连接」这一行不画。 */
  onAdd?: () => void
  addHint: string
  busy: boolean
  description: ReactNode
  notice: ReactNode
  /** 正在用的连接登不上时的「登录」按钮,摆在选择框左边。 */
  signIn?: ReactNode
  /** 连接列表读不出(原因在 `notice` 里):不摆一个一直「正在检查」的选择框。 */
  unreadable?: boolean
  embedded?: boolean
  children: ReactNode
  /** 「添加连接」的就地表单;给了就展开在那一行里。 */
  form: ReactNode
}) {
  const { translate } = useSessionMessages()
  const current = connections?.find((c) => c.current)
  const name =
    current?.kind === 'native' ? translate('subscriptions.connections.existing') : current?.name
  const rows = (
    <>
      <SettingsRow
        title={translate('agentsPage.currentConnection')}
        description={description}
        control={
          <div className="flex items-center gap-2">
            {signIn}
            {unreadable ? null : connections?.length === 0 ? (
              // 一个连接都没有:照实写没有,❌ 摆一个只能选空气的选择框。
              <span
                className="text-sm text-foreground-muted"
                data-testid={`subscription-no-connection-${agentId}`}
              >
                {translate('agentsPage.noConnection')}
              </span>
            ) : (
              <Select
                items={connections?.map((c) => ({
                  value: c.id,
                  label:
                    c.kind === 'native' ? translate('subscriptions.connections.existing') : c.name
                }))}
                value={current?.id ?? null}
                open={open}
                onOpenChange={onOpenChange}
                onValueChange={(value) => {
                  if (value !== null) onSelect(String(value))
                }}
                disabled={busy || !connections}
              >
                <SelectTrigger
                  className="w-[156px]"
                  aria-label={translate('agentsPage.currentConnection')}
                  data-testid={`subscription-switch-${agentId}`}
                >
                  <SelectValue>
                    {name ??
                      translate(connections ? 'agentsPage.noConnection' : 'subscriptions.checking')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end" className="min-w-[300px]">
                  {children}
                </SelectContent>
              </Select>
            )}
          </div>
        }
      >
        {notice}
      </SettingsRow>
      {onAdd && (
        // 表单就地展开在这一行里(照「来源」那一行的「自定义路径」):展开期间「添加」收起,收回去靠表单里的「取消」。
        <SettingsRow
          title={translate('subscriptions.connections.add')}
          description={addHint}
          control={
            form ? undefined : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={onAdd}
                data-testid={`subscription-add-${agentId}`}
              >
                {translate('agentsPage.addConnectionAction')}
              </Button>
            )
          }
        >
          {form && <div className="agent-connection-form pt-1">{form}</div>}
        </SettingsRow>
      )}
    </>
  )
  if (embedded)
    return (
      <div className="agent-connection-rows" data-testid={`connection-block-${agentId}`}>
        {rows}
      </div>
    )
  return (
    <SettingsGroup
      title={translate('agentsPage.connectionGroup')}
      className="agent-connection-settings"
      data-testid={`connection-block-${agentId}`}
    >
      {rows}
    </SettingsGroup>
  )
}
