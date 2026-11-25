import type { ComposerModelOption } from '@gugu/session-ui/react/components'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  guguCatalogReasonKind,
  type SessionpageSessionCreateModels,
  type SessionpageSessionCreateOptions,
} from '@gugu/session-core/session-record/contract'
import { Check, ChevronDown, ChevronLeft, ChevronRight, X } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SearchField } from '@/components/ui/SearchField'
import { Sheet } from '@/components/ui/Sheet'
import {
  createPillLabel,
  createPermissionModes,
  harnessBlockReason,
  harnessUsable,
  selectHarness,
  selectedEffortName,
  selectedModelName,
  type CreateSelection,
} from './create-session-form'
import { createModelOptions } from './session-model-menu'
import { allGuguHidden, offeredInCreateMenu } from '@/lib/createModelDefault'
import { PhoneComposerChoice } from '../../mobile/composer/PhoneComposerChoice'
import { ModelMenuFooter } from './ModelMenuFooter'
import { phoneModelDescription, phoneModelName } from './phone-model-copy'
import { composerModelSelection, composerTierLabel } from '@renderer/features/sessions/session-config/use-composer-model-options'
import { guguReasonText } from '@renderer/features/sessions/gugu-reason'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import './task-flow-catalog'
import './create-controls-catalog'
import './agent-watch.css'

/**
 * 新建会话的「harness · 模型」胶囊:摆在输入框那一行、只写值、抽屉下钻(顶层 = 摘要行,点进各维)、
 * 填满圆点打勾 —— 「说这句话之前先定个调」。项目与机器不在这里:输入框上方那两行(CreateTarget)。
 *
 * 选完**不关**(owner 10-07「调完一个设置后还可以继续调另一个,而不是每次都要重新点开设置」):
 * 在下钻页选 → 回顶层,摘要行上就是刚改的值,接着点下一项。
 * 关只靠 ✕ 和点遮罩。
 *
 * 这里的选择**只在手机上**,发送时才随请求带过去,❌ 不逐项下发到机器 ——
 * 会话还不存在,机器上没有可改的东西。
 *
 * 不能用的 harness **照列不藏**,行上写明是「没装」「装了但坏了」还是「手机端读不了它的记录」,但点不动:
 * 藏掉的话人只看到一个短列表,说不出为什么想用的那家不在。
 */
export function CreateOptionsPill({
  options,
  selection,
  onChange,
  busy,
  models,
  modelsState,
  phoneHost = false,
}: {
  options: SessionpageSessionCreateOptions
  selection: CreateSelection
  /** 模型点选另报，区分“明确不指定”和尚未定默认；改项目/权限不算选过模型。 */
  onChange: (next: CreateSelection, modelPicked?: boolean) => void
  /** 正在建 —— 发出去之后再改,请求已经带着旧值在路上了。 */
  busy: boolean
  /** 选定 harness 的模型目录;还没到 / 探失败时 null,由 `modelsState` 说明是哪种。 */
  models: SessionpageSessionCreateModels | null
  modelsState: 'idle' | 'loading' | 'ready' | 'failed'
  phoneHost?: boolean
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const [view, setView] = useState<'root' | 'harness' | 'permission' | 'model' | 'effort' | null>(null)
  const baseHarnessOption = options.harnesses.find((h) => h.id === selection.harness) ?? null
  const harnessOption = baseHarnessOption ? { ...baseHarnessOption, permissionModes: createPermissionModes(baseHarnessOption, models, modelsState, selection) } : undefined
  const label = createPillLabel(options, selection, models, phoneHost ? tFlow('phoneAgent') : undefined)

  // 一个值都没有就整个不画(与会话选项胶囊同一条):机器上没有 harness 的情形,
  // 页面正文已经在说原因了,这里再摆一个空胶囊只会多一个「这是啥」。
  if (!label) return null

  const root = phoneHost ? 'model' : 'root'
  const atRoot = view === root
  const backToRoot = () => setView(root)
  const viewName = view === 'root' || view === null ? t('agentWatch.options.title') : t(`agentWatch.create.${view === 'permission' ? 'permissionLabel' : view}`)

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gg-aw-pill"
        disabled={busy}
        data-testid="agent-watch-create-options-open"
        aria-haspopup="dialog"
        aria-expanded={view !== null}
        onClick={() => setView(root)}
      >
        <span className="gg-aw-pill-text">{label}</span>
        <ChevronDown />
      </Button>

      <Sheet
          open={view !== null}
          onClose={() => setView(null)}
          mobileFitContent
          testId="agent-watch-create-options"
          ariaLabel={viewName}
        >
          {view ? <div className="gg-aw gg-aw-sheet">
            <div className="gg-aw-sheet-head">
              <IconButton
                size="lg"
                className="gg-aw-sheet-nav"
                aria-label={atRoot ? t('agentWatch.options.close') : t('agentWatch.options.back')}
                data-testid="agent-watch-create-options-nav"
                onClick={() => (atRoot ? setView(null) : backToRoot())}
              >
                {atRoot ? <X /> : <ChevronLeft />}
              </IconButton>
              <div className="gg-aw-sheet-title">
                {view === 'root' ? viewName : t('agentWatch.options.pick', { name: viewName })}
              </div>
              <div className="gg-aw-sheet-side" />
            </div>

            {view === 'permission' ? (
              <ChoiceList
                dimension="permission"
                defaultChoice={{ name: t('agentWatch.create.modelDefault'), desc: t('agentWatch.create.permissionDefaultHint') }}
                choices={(harnessOption?.permissionModes ?? []).map((m) => ({
                  id: m,
                  name: t(`agentWatch.create.permission.${m}.name`),
                  desc: m === 'ai-review' && models?.autoReview?.disabled ? translateSessionMessage('taskConfig.reviewUnavailable') : t(`agentWatch.create.permission.${m}.desc`),
                  disabled: m === 'ai-review' && models?.autoReview?.disabled,
                }))}
                selected={selection.permissionMode}
                onPick={(id) => {
                  onChange({ ...selection, permissionMode: id as CreateSelection['permissionMode'] })
                  backToRoot()
                }}
              />
            ) : view === 'effort' ? (
              <ChoiceList
                dimension="effort"
                defaultChoice={{ name: t('agentWatch.create.modelDefault'), desc: t('agentWatch.create.effortDefaultHint') }}
                choices={(models?.efforts ?? []).map((e) => ({ id: e.id, name: e.name, desc: e.description }))}
                selected={selection.effort}
                onPick={(id) => {
                  onChange({ ...selection, effort: id })
                  backToRoot()
                }}
              />
            ) : view === 'model' ? (
              <ModelChoices
                models={models}
                platformOnly={phoneHost || harnessOption?.chatAvailable === true && !harnessOption.watchable}
                harnessName={phoneHost ? tFlow('phoneAgent') : harnessOption?.name ?? selection.harness ?? ''}
                state={modelsState}
                selection={selection}
                onPick={(model) => {
                  onChange({ ...selection, model }, true)
                  backToRoot()
                }}
                onLeave={() => setView(null)}
              />
            ) : view === 'harness' ? (
              <div className="gg-aw-choice-group" role="radiogroup" data-dimension="harness">
                {options.harnesses.map((harness) => {
                  const selected = harness.id === selection.harness
                  const usable = harnessUsable(harness)
                  const reason = harnessBlockReason(harness)
                  return (
                    <Button
                      key={harness.id}
                      variant="ghost"
                      size="option"
                      className="gg-aw-choice"
                      role="radio"
                      aria-checked={selected}
                      disabled={!usable}
                      data-testid="agent-watch-create-choice"
                      data-dimension="harness"
                      data-option-id={harness.id}
                      data-status={harness.status}
                      onClick={() => {
                        // 换 harness 会把模型、推理档等重置成那一家的(selectHarness);回顶层后摘要行读的就是新的。
                        onChange(selectHarness(selection, harness.id, options))
                        backToRoot()
                      }}
                    >
                      <span className="gg-aw-choice-radio" data-on={selected ? 'true' : undefined}>
                        {selected ? <Check /> : null}
                      </span>
                      <span className="gg-aw-choice-body">
                        <span className="gg-aw-choice-label">{harness.name}</span>
                        {reason ? (
                          <span className="gg-aw-choice-desc">
                            {t(`agentWatch.create.harnessStatus.${reason}`)}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  )
                })}
              </div>
            ) : null}

            {atRoot ? (
              <div className="gg-aw-summary-group">
                {!phoneHost && <Button
                  variant="ghost"
                  size="option"
                  className="gg-aw-summary"
                  data-testid="agent-watch-create-options-drill"
                  data-dimension="harness"
                  onClick={() => setView('harness')}
                >
                  <span className="gg-aw-summary-label">{t('agentWatch.create.harness')}</span>
                  <span className="gg-aw-summary-value">
                    {harnessOption?.name ?? t('agentWatch.options.unknownValue')}
                  </span>
                  <ChevronRight />
                </Button>}
                {/* 展示(编程/通用)不在这里选:那台电脑按自己的「终端」开关定。 */}
                {/* 权限档:这家声明了才摆(桌面同一条:不摆不存在的档)。 */}
                {!phoneHost && harnessOption && harnessOption.permissionModes.length > 0 ? (
                  <SummaryRow
                    dimension="permission"
                    label={t('agentWatch.options.mode')}
                    value={selection.permissionMode
                      ? t(`agentWatch.create.permission.${selection.permissionMode}.name`)
                      : t('agentWatch.create.modelDefault')}
                    onClick={() => setView('permission')}
                  />
                ) : null}
                {/* 模型一行:harness 选定后才有意义;写「默认」而不是留空 —— 不指定本身就是一个明确的选择。 */}
                {!phoneHost && <Button
                  variant="ghost"
                  size="option"
                  className="gg-aw-summary"
                  data-testid="agent-watch-create-options-drill"
                  data-dimension="model"
                  disabled={!selection.harness}
                  onClick={() => setView('model')}
                >
                  <span className="gg-aw-summary-label">{t('agentWatch.create.model')}</span>
                  <span className="gg-aw-summary-value">
                    {selectedModelName(models, selection)
                      ?? (modelsState === 'loading' && (!models || models.harness !== selection.harness)
                        ? t('agentWatch.create.modelLoading')
                        : t('agentWatch.create.modelDefault'))}
                  </span>
                  <ChevronRight />
                </Button>}
                {/* 推理档:引擎不声明就不摆。 */}
                {models && models.efforts.length > 0 ? (
                  <SummaryRow
                    dimension="effort"
                    label={t('agentWatch.options.effort')}
                    value={selectedEffortName(models, selection) ?? t('agentWatch.create.modelDefault')}
                    onClick={() => setView('effort')}
                  />
                ) : null}
              </div>
            ) : null}
          </div> : null}
        </Sheet>
    </>
  )
}

function SummaryRow({
  dimension,
  label,
  value,
  onClick,
}: {
  dimension: string
  label: string
  value: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="option"
      className="gg-aw-summary"
      data-testid="agent-watch-create-options-drill"
      data-dimension={dimension}
      onClick={onClick}
    >
      <span className="gg-aw-summary-label">{label}</span>
      <span className="gg-aw-summary-value">{value}</span>
      <ChevronRight />
    </Button>
  )
}

/** 一维的单选列表:可选的「默认」行在最前(表示不指定、交给那一家),然后是各选项。 */
function ChoiceList({
  dimension,
  choices,
  selected,
  defaultChoice,
  onPick,
}: {
  dimension: string
  choices: Array<{ id: string; name: string; desc?: string; disabled?: boolean }>
  selected: string | null
  defaultChoice?: { name: string; desc: string }
  onPick: (id: string | null) => void
}) {
  const rows: Array<{ id: string | null; name: string; desc?: string; disabled?: boolean }> = defaultChoice
    ? [{ id: null, ...defaultChoice }, ...choices]
    : choices
  return (
    <div className="gg-aw-choice-group" role="radiogroup" data-dimension={dimension}>
      {rows.map((row) => {
        const isSelected = selected === row.id
        return (
          <Button
            key={row.id ?? '__default__'}
            variant="ghost"
            size="option"
            className="gg-aw-choice"
            role="radio"
            aria-checked={isSelected}
            disabled={row.disabled}
            data-testid="agent-watch-create-choice"
            data-dimension={dimension}
            data-option-id={row.id ?? ''}
            onClick={() => onPick(row.id)}
          >
            <span className="gg-aw-choice-radio" data-on={isSelected ? 'true' : undefined}>
              {isSelected ? <Check /> : null}
            </span>
            <span className="gg-aw-choice-body">
              <span className="gg-aw-choice-label">{row.name}</span>
              {row.desc ? <span className="gg-aw-choice-desc">{row.desc}</span> : null}
            </span>
          </Button>
        )
      })}
    </div>
  )
}

/**
 * 模型页顶部搜索，然后 harness 自家一组、咕咕平台一组。
 * (与桌面下拉同序)。哪一组缺席就在组名下写机器报来的原因,❌ 不藏:空列表说不出「为什么空」。
 */
export function ModelChoices({
  models,
  platformOnly = false,
  harnessName,
  state,
  selection,
  onPick,
  onLeave,
  sessionOptions,
}: {
  sessionOptions?: Record<string, ComposerModelOption>
  models: SessionpageSessionCreateModels | null
  platformOnly?: boolean
  /** 「你的 X 模型」的 X。 */
  harnessName: string
  state: 'idle' | 'loading' | 'ready' | 'failed'
  selection: CreateSelection
  onPick: (model: string | null) => void
  /** 底部「管理模型」去设置之前收起这张面板。 */
  onLeave: () => void
}) {
  const { t } = useTranslation('main')
  const { t: controls } = useTranslation('mobileCreateControls')
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase()
  const matches = (id: string, name: string, description?: string) =>
    !query || [id, name, description ?? ''].some((value) => value.toLocaleLowerCase().includes(query))
  const ownModelCopy = (id: string, name: string, description?: string) => ({
    name: phoneModelName(id, name, controls),
    description: phoneModelDescription(id, name, description, controls),
  })
  const sessionRows = Object.entries(sessionOptions ?? {}).filter(([, option]) => !option.hiddenFromPicker).map(([id, option]) => ({
    id, ...option, ...(composerModelSelection(id).source === 'platform' ? {} : ownModelCopy(id, option.name, option.description)),
  })).filter(({ id, name, description }) => matches(id, name, description))
  // 组头、倍率与桌面模型菜单同一份装配(session-model-menu)。
  const options = models ? createModelOptions(models, harnessName) : {}
  // A harness row the shared assembly hid or dropped (a `default` placeholder, owner 11-25) stays out of this list too.
  const listed = (model: { id: string; source: string }) => model.source !== 'harness' || (!!options[model.id] && !options[model.id]!.hiddenFromPicker)
  const offeredRows = models?.models.filter((model) => (!platformOnly || model.source === 'gugu') && offeredInCreateMenu(model) && listed(model)) ?? []
  const filteredRows = offeredRows.map((model) => {
    const name = options[model.id]?.name ?? model.name
    return model.source === 'harness'
      ? { ...model, ...ownModelCopy(model.id, name, options[model.id]?.description) }
      : { ...model, name, description: options[model.id]?.description }
  }).filter(({ id, name, description }) => matches(id, name, description))
  const searchField = <div className="gg-aw-model-search"><SearchField value={search}
    placeholder={controls('searchModels')} onValueChange={setSearch}
    clearLabel={controls('clearModelSearch')} onClear={() => setSearch('')} /></div>
  // 组空时写什么:harness 那组按探测状态措辞(状态码 ❌ 不给人看),`unavailable` 再附机器原话;
  // 咕咕那组机器报的是原因码,按界面语言说(老版本机器送来的原文认成「暂时用不了」,❌ 原样写)。
  const harnessEmptyText = (m: SessionpageSessionCreateModels): string => {
    const base = t(`agentWatch.create.modelHarnessState.${m.harnessState}`)
    return m.harnessState === 'unavailable' && m.harnessReason ? `${base}:${m.harnessReason}` : base
  }
  const guguEmptyText = (raw: string | null | undefined): string | null => {
    const kind = guguCatalogReasonKind(raw)
    return kind ? guguReasonText(kind, translateSessionMessage) : null
  }
  const groups: Array<{ source: 'harness' | 'gugu'; reason: string | null }> = [
    { source: 'harness', reason: models ? harnessEmptyText(models) : null },
    { source: 'gugu', reason: guguEmptyText(models?.guguReason) },
  ]
  const choice = (id: string | null, name: string, description?: string, source?: 'harness' | 'gugu', disabled = false) => (
    <PhoneComposerChoice key={id ?? '__default__'} id={id ?? ''} dimension="model" name={name}
      description={description} selected={selection.model === id} disabled={disabled}
      testId="agent-watch-create-choice" source={source} onClick={() => onPick(id)} />
  )
  if (sessionOptions) return <div className="gg-aw-model-choices">{searchField}
    <div className="gg-aw-choice-group" role="radiogroup" data-dimension="model" data-state="ready">
      {sessionRows.map((option) => choice(option.id, option.name, option.disabledReason ?? option.description, undefined, option.disabled))}
    </div>
    {query && !sessionRows.length && <p role="status" className="gg-aw-choice-note">{controls('noMatchingModels')}</p>}
  </div>
  return (
    <div className="gg-aw-model-choices">{searchField}
    <div className="gg-aw-choice-group" role="radiogroup" data-dimension="model" data-state={state}>
      {state === 'loading' ? (
        <div className="gg-aw-choice-desc gg-aw-choice-note" data-testid="agent-watch-create-models-note">
          {t('agentWatch.create.modelLoading')}
        </div>
      ) : state === 'failed' ? (
        <div className="gg-aw-choice-desc gg-aw-choice-note" data-testid="agent-watch-create-models-note">
          {t('agentWatch.create.modelFailed')}
        </div>
      ) : null}
      {models
        ? groups.filter(({ source }) => (!platformOnly || source === 'gugu')
          && (source !== 'harness' || offeredRows.length === 0 || filteredRows.some((model) => model.source === source))
          && (!query || filteredRows.some((model) => model.source === source))).map(({ source, reason }) => {
            // 只列点得中、跑得起来的:要会员的、他在设置里关掉的都不列(#7056,与桌面下拉同一个判据)。
            const rows = filteredRows.filter((m) => m.source === source)
            return (
              <div key={source} className="gg-aw-choice-section" data-source={source}>
                <div className="gg-aw-choice-section-title">
                  {composerTierLabel(source === 'gugu' ? 'platform' : 'own', harnessName)}
                </div>
                {rows.length > 0
                  ? rows.map((m) => choice(m.id, m.name, m.description, m.source))
                  : (
                    <div className="gg-aw-choice-desc gg-aw-choice-note" data-testid="agent-watch-create-models-empty" data-source={source}>
                      {source === 'gugu' && allGuguHidden(models)
                        ? t('agentWatch.create.modelGuguAllHidden')
                        : (reason ?? t('agentWatch.create.modelNone'))}
                    </div>
                  )}
              </div>
            )
          })
        : null}
      {query && state === 'ready' && !filteredRows.length && <p role="status" className="gg-aw-choice-note">{controls('noMatchingModels')}</p>}
      {models && !query ? (
        <ModelMenuFooter
          lockedModels={models.models.filter((m) => m.source === 'gugu' && m.requires_membership).map((m) => m.name)}
          onLeave={onLeave}
        />
      ) : null}
    </div>
    </div>
  )
}
