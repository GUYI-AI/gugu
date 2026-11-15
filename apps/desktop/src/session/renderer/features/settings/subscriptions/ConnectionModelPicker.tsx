import { useEffect, useId, useState } from 'react'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { Input } from '@renderer/lib/ui/input'
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor
} from '@renderer/lib/ui/combobox'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { errorText } from './subscription-queries'

/**
 * 从哪读模型清单(#2507):表单里还没存的连接给 key 和地址(地址缺席 = 这家的官方地址);已存的连接(「管理模型」)给它的 id,
 * key 由宿主自己解。读一律在宿主进程里做,key 只到那个地址 —— renderer ❌ 自己去 fetch。
 */
export type ConnectionModelSource = { apiKey: string; endpoint?: string } | { connectionId: string }

type ModelList =
  | { kind: 'waiting' }
  | { kind: 'reading' }
  | { kind: 'listed'; models: string[] }
  | { kind: 'unlisted'; reason: 'no-list' | 'unauthorized' | 'unreachable' }
  | { kind: 'failed'; message: string }

/** 手填的几个模型名:逗号(中英文)、空格、换行都算隔开;去空、去重。 */
export function parseModelNames(text: string): string[] {
  return [...new Set(text.split(/[\s,，]+/).map((name) => name.trim()).filter(Boolean))]
}

/** key / 地址一变就重读(表单里打字时等 400ms 停下再读);已存的连接立刻读。 */
function useConnectionModelList(
  machine: string | null,
  providerId: string,
  source: ConnectionModelSource | null
): ModelList {
  const connectionId = source && 'connectionId' in source ? source.connectionId : undefined
  const apiKey = source && 'apiKey' in source ? source.apiKey : undefined
  const endpoint = source && 'apiKey' in source ? source.endpoint : undefined
  const [list, setList] = useState<ModelList>({ kind: 'waiting' })
  useEffect(() => {
    if (!connectionId && !apiKey) {
      setList({ kind: 'waiting' })
      return
    }
    let cancelled = false
    setList({ kind: 'reading' })
    const timer = setTimeout(
      async () => {
        try {
          const client = await getAgentConfigRuntimeClient(machine)
          const result = await client.listConnectionModels(
            connectionId
              ? { providerId, connectionId }
              : { providerId, apiKey: apiKey!, ...(endpoint ? { endpoint } : {}) }
          )
          if (cancelled) return
          if (!result.success) setList({ kind: 'failed', message: errorText(result.error) })
          else if (result.data.kind === 'listed' && result.data.models.length > 0)
            setList({ kind: 'listed', models: result.data.models })
          else setList({ kind: 'unlisted', reason: result.data.kind === 'unlisted' ? result.data.reason : 'no-list' })
        } catch (error) {
          if (!cancelled) setList({ kind: 'failed', message: errorText(error) })
        }
      },
      connectionId ? 0 : 400
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [machine, providerId, connectionId, apiKey, endpoint])
  return list
}

/**
 * 一把连接点名的模型(#2507,owner:「如果多个模型那?」):地址报得出清单 ⇒ 带搜索的多选,至少勾一个;
 * 报不出 ⇒ 一行说为什么,退回手填(可以填好几个)。新建连接与「管理模型」用的是这同一个。
 */
export function ConnectionModelPicker({
  machine,
  providerId,
  source,
  value,
  onChange
}: {
  machine: string | null
  providerId: string
  /** null = key / 地址还没填好,先不读。 */
  source: ConnectionModelSource | null
  value: string[]
  onChange: (models: string[]) => void
}) {
  const { translate } = useSessionMessages()
  const list = useConnectionModelList(machine, providerId, source)
  const anchor = useComboboxAnchor()
  const labelId = useId()
  const [manual, setManual] = useState(() => value.join(', '))
  // 搜索词自己管、清单自己筛:交给组件内部筛时,勾上一条之后再打字,清单停在上一次的结果上(@base-ui/react 1.6.0 实测)。
  const [query, setQuery] = useState('')
  if (list.kind === 'unlisted' || list.kind === 'failed') {
    return (
      <div className="subscription-connection-models">
        <label>
          {translate('subscriptions.connections.models')}
          <Input
            name="models"
            required
            autoComplete="off"
            spellCheck={false}
            value={manual}
            placeholder={translate('subscriptions.connections.modelsManual')}
            onChange={(event) => {
              setManual(event.target.value)
              onChange(parseModelNames(event.target.value))
            }}
          />
        </label>
        <p className="subscription-connection-description" data-testid="connection-models-unlisted">
          {list.kind === 'failed'
            ? list.message
            : translate(`subscriptions.connections.modelsUnlisted.${list.reason}`)}
        </p>
      </div>
    )
  }
  // 清单照地址报的顺序;已点名、清单里却没有的(「管理模型」时地址不再报它)接在后面照样摆着,取消勾选才去掉。
  const items = list.kind === 'listed' ? [...list.models, ...value.filter((model) => !list.models.includes(model))] : value
  const needle = query.trim().toLowerCase()
  const shown = needle ? items.filter((model) => model.toLowerCase().includes(needle)) : items
  return (
    <div className="subscription-connection-models">
      <span id={labelId}>{translate('subscriptions.connections.models')}</span>
      <Combobox<string, true>
        multiple
        items={items}
        filteredItems={shown}
        inputValue={query}
        onInputValueChange={setQuery}
        value={value}
        onValueChange={(next) => onChange([...next])}
        disabled={list.kind !== 'listed'}
      >
        <ComboboxChips ref={anchor} data-testid="connection-models">
          <ComboboxValue>
            {(selected: string[]) => (
              <>
                {selected.map((model) => (
                  <ComboboxChip key={model}>{model}</ComboboxChip>
                ))}
                <ComboboxChipsInput
                  aria-labelledby={labelId}
                  placeholder={
                    selected.length > 0
                      ? ''
                      : translate(
                          list.kind === 'waiting'
                            ? 'subscriptions.connections.modelsWaiting'
                            : list.kind === 'reading'
                              ? 'subscriptions.connections.modelsReading'
                              : 'subscriptions.connections.modelsSearch'
                        )
                  }
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>{translate('subscriptions.connections.modelsNoMatch')}</ComboboxEmpty>
          <ComboboxList>
            {(model: string) => (
              <ComboboxItem key={model} value={model}>
                {model}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
}

/** 连接那一行写它点名的模型:两个以内全写,多了写第一个 +N。 */
export function modelsLine(
  models: readonly string[] | undefined,
  translate: ReturnType<typeof useSessionMessages>['translate']
): string | undefined {
  if (!models?.length) return undefined
  if (models.length <= 2) return models.join(', ')
  return translate('subscriptions.connections.moreModels', { first: models[0], count: models.length - 1 })
}
