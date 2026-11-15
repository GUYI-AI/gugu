import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder, FolderPlus, FileText, Home, Link as LinkIcon, RefreshCw } from '@/lib/icons'
import { deviceFsMakeDirectory } from '../lib/deviceFs'
import type { DeviceFsEntry } from '@gugu/core/cloud/deviceFsProtocol'
import { remoteDirectory, RemoteDirectoryError, UNREACHABLE_PATH_CODES, type RemoteDirectory } from '../lib/remoteDirectory'
import { useReplica } from '../lib/replica'
import type { DeviceRpcError } from '../lib/deviceRpc'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { rendererLogger } from '../lib/log'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { SearchField } from './ui/SearchField'
import {
  broadRootKind,
  completionCandidates,
  filterEntries,
  isEnterable,
  joinPath,
  newFolderNameProblem,
  pathSegments,
  splitCompletionDraft,
} from './remoteFolderPath'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'

const LIST_DIRECTORY_TIMEOUT_MS = 20_000
const COMPLETION_DEBOUNCE_MS = 150
const log = rendererLogger('remote-folder-picker')

type Props = {
  deviceId: string
  initialPath?: string
  onSelect: (path: string) => void
  onCancel?: () => void
}

/** A folder the picker goes to (the listing is the `remoteDirectory` reading of it). */
type Place = { path: string; hidden: boolean }

/**
 * 最近一次「去某个路径」没去成的原因。它不替换手上那份读数 —— 去不成就留在原地、说清楚为什么,
 * ❌ 不再像旧版那样自己跳回上一级、再被下一次读取把错误抹掉(那样用户只看到目录闪了一下)。
 */
type NavError =
  | { kind: 'rpc'; path: string; error: DeviceRpcError }
  | { kind: 'timeout'; path: string }
  | { kind: 'unreachable'; path: string }

type NewFolderState = { name: string; busy: boolean; error: string | null }

function navErrorOf(path: string, error: Error): NavError {
  if (error instanceof RemoteDirectoryError) return { kind: 'rpc', path, error: error.rpcError }
  // @@@remote-dir-timeout-hint (#670) - surface the device-RPC timeout as an actionable message
  // (host unreachable / old build) instead of the raw "设备 RPC timed out after Nms" string.
  return { kind: error.name === 'DeviceRpcTimeoutError' ? 'timeout' : 'unreachable', path }
}

function navErrorMessage(error: NavError, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (error.kind === 'timeout') return t('create.remoteFolders.error.timeout')
  if (error.kind === 'unreachable') return t('create.remoteFolders.error.unreachable')
  const path = error.path
  switch (error.error.code) {
    case 'path_blocked':
      return t('create.remoteFolders.error.pathBlocked')
    case 'permission_denied':
      return t('create.remoteFolders.error.permissionDeniedPath', { path })
    case 'not_found':
      return t('create.remoteFolders.error.notFoundPath', { path })
    case 'not_a_directory':
      return t('create.remoteFolders.error.notDirectoryPath', { path })
    case 'invalid_path':
      return t('create.remoteFolders.error.invalidPath')
    case 'unauthorized':
      return t('create.remoteFolders.error.unauthorized')
    default:
      // 内部错误原文进日志,界面只说发生了什么、下一步做什么。
      return t('create.remoteFolders.error.unknown')
  }
}

function entryIcon(kind: DeviceFsEntry['kind']) {
  if (kind === 'dir') return <Folder size={14} />
  if (kind === 'symlink') return <LinkIcon size={14} />
  return <FileText size={14} />
}

export function RemoteFolderPicker({ deviceId, initialPath = '~', onSelect, onCancel }: Props) {
  const { t } = useTranslation('agents')
  /** Where the picker is going (view state); the folder's entries are the `remoteDirectory` reading of it. */
  const [target, setTarget] = useState<Place>({ path: initialPath, hidden: false })
  /** Where it stood when it set off: still shown (and usable) while `target` is being read or could not be read. */
  const [from, setFrom] = useState<Place | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [filter, setFilter] = useState('')
  const [confirmBroad, setConfirmBroad] = useState<'root' | 'home' | null>(null)
  const [newFolder, setNewFolder] = useState<NewFolderState | null>(null)

  // A new device or first path is a new picker.
  const [opened, setOpened] = useState({ deviceId, initialPath })
  if (opened.deviceId !== deviceId || opened.initialPath !== initialPath) {
    setOpened({ deviceId, initialPath })
    setTarget({ path: initialPath, hidden: false })
    setFrom(null)
  }

  const asked = useReplica(remoteDirectory, [deviceId, target.path, target.hidden])
  // 首次打开:先去调用方给的起点;那里去不了(被删了、没权限)就退回主目录,❌ 停在一片空白上。A derivation, not a
  // second navigation: the first place shown is the home folder while the asked one is not a place to stand.
  const fellBack = from === null && target.path === initialPath && target.path !== '~' && asked.state === 'error'
    && asked.error instanceof RemoteDirectoryError && UNREACHABLE_PATH_CODES.includes(asked.error.rpcError.code)
  const current: Place = useMemo(() => (fellBack ? { path: '~', hidden: target.hidden } : target), [fellBack, target])
  const reading = useReplica(remoteDirectory, fellBack ? [deviceId, current.path, current.hidden] : [deviceId, target.path, target.hidden])
  // Already read (it was shown): held as it is, ❌ read again for standing on it.
  const standing = useReplica(remoteDirectory, from ? [deviceId, from.path, from.hidden] : null, { read: false })
  // An older machine reports its home only when `~` is listed: what a listing of `~` said, if one was read.
  const tilde = useReplica(remoteDirectory, [deviceId, '~', false], { read: false })

  /** The folder shown: the one asked for once it is read, until then the one stood on. */
  const listing: RemoteDirectory | null = reading.state === 'value' ? reading.value : standing.state === 'value' ? standing.value : null
  const loading = reading.state === 'unknown'
  const navError = reading.state === 'error' ? navErrorOf(current.path, reading.error) : null
  const home = listing?.home ?? (tilde.state === 'value' ? tilde.value.home : null)
  const truncatedCount = listing?.truncated ?? null

  // @@@remote-dir-progress (#848) - show elapsed seconds while loading so the wait for the remote
  // device-RPC never reads as a frozen "永远 loading" (the call times out after 20 s). A view timer, not a read.
  const [loadElapsed, setLoadElapsed] = useState(0)
  useEffect(() => {
    setLoadElapsed(0)
    if (!loading) return
    const timer = setInterval(() => setLoadElapsed((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [loading, current.path, current.hidden])

  /**
   * 地址栏可以直接输入路径(与访达「前往文件夹」、文件选择框敲 `/` 同一个习惯):已知路径时一层层点太慢,
   * 尤其是服务器上动辄十几层的目录(owner 反馈「如果能输入路径会方便很多」)。
   * null = 不在编辑;字符串 = 正在编辑的草稿。回车前往,Tab 补全,Esc 放弃。
   */
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  const pathInputRef = useRef<HTMLInputElement | null>(null)
  const [highlight, setHighlight] = useState(-1)

  const navigate = useCallback((path: string, hidden: boolean) => {
    // Stand on what is shown now (a one-moment decision); a target never read stays out of it.
    const shown = remoteDirectory.peek(deviceId, current.path, current.hidden)
    if (shown.state === 'value') setFrom(current)
    setTarget({ path, hidden })
    setConfirmBroad(null)
    setFilter('')
    setNewFolder(null)
    // Asked again for the folder already shown (refresh / the same path typed): read it now.
    if (path === current.path && hidden === current.hidden) void remoteDirectory.refresh(deviceId, path, hidden)
  }, [current, deviceId])

  const goTo = useCallback((path: string) => { navigate(path, showHidden) }, [navigate, showHidden])
  const retry = useCallback(() => { void remoteDirectory.refresh(deviceId, current.path, current.hidden) }, [current, deviceId])

  // ── 地址栏补全 ─────────────────────────────────────────────────────────────
  const draftSplit = pathDraft === null ? null : splitCompletionDraft(pathDraft)
  const completionDir = draftSplit?.dir ?? null
  // 正在看的就是这个目录:直接用手上的读数,不再跨云问一趟。
  const completingShown = completionDir !== null && listing !== null && (completionDir === listing.path || (completionDir === '~' && home === listing.path))
  // The address bar asks the machine once typing pauses (the key is a debounced view value; the read is the replica's).
  const [askedDir, setAskedDir] = useState<string | null>(null)
  useEffect(() => {
    if (completionDir === null || completingShown) { setAskedDir(null); return }
    const timer = setTimeout(() => setAskedDir(completionDir), COMPLETION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [completionDir, completingShown])
  const completion = useReplica(remoteDirectory, askedDir !== null && askedDir === completionDir ? [deviceId, askedDir, true] : null)
  const completionEntries: DeviceFsEntry[] | null = completingShown ? listing.entries : completion.state === 'value' ? completion.value.entries : null
  const suggestions = useMemo(
    () => (draftSplit && completionEntries ? completionCandidates(completionEntries, draftSplit.prefix) : []),
    [completionEntries, draftSplit],
  )
  const completionError = pathDraft !== null && !completingShown && completion.state === 'error' ? navErrorOf(completion.error instanceof RemoteDirectoryError ? completion.error.path : askedDir ?? '', completion.error) : null
  useEffect(() => { setHighlight(-1) }, [pathDraft])

  const selectPathOnMount = useRef(false)
  const mountPathInput = useCallback((input: HTMLInputElement | null) => {
    pathInputRef.current = input
    if (!input) return
    // Transfer focus in the same commit that removes the focused breadcrumb button.
    // Deferring this to a frame lets the dialog schedule its own lost-focus restoration.
    input.focus()
    if (selectPathOnMount.current) input.select()
  }, [])
  const startEditingPath = useCallback((initial?: string) => {
    selectPathOnMount.current = initial === undefined
    setPathDraft(initial ?? listing?.path ?? current.path)
  }, [current.path, listing])
  const acceptSuggestion = useCallback((entry: DeviceFsEntry) => {
    if (!draftSplit) return
    setPathDraft(joinPath(draftSplit.dir, entry.name) + '/')
    requestAnimationFrame(() => pathInputRef.current?.focus())
  }, [draftSplit])
  const commitPathDraft = useCallback(() => {
    const picked = highlight >= 0 ? suggestions[highlight] : undefined
    const target = picked && draftSplit ? joinPath(draftSplit.dir, picked.name) : pathDraft?.trim()
    setPathDraft(null)
    if (target) goTo(target.length > 1 ? target.replace(/\/+$/, '') : target)
  }, [draftSplit, goTo, highlight, pathDraft, suggestions])

  // ── 新建文件夹 ─────────────────────────────────────────────────────────────
  const submitNewFolder = useCallback(async () => {
    if (!listing || !newFolder || newFolder.busy) return
    const problem = newFolderNameProblem(newFolder.name)
    if (problem) {
      setNewFolder({ ...newFolder, error: t(problem === 'empty' ? 'create.remoteFolders.newFolderError.empty' : 'create.remoteFolders.newFolderError.invalid') })
      return
    }
    const target = joinPath(listing.path, newFolder.name.trim())
    setNewFolder({ ...newFolder, busy: true, error: null })
    try {
      const response = await deviceFsMakeDirectory(deviceId, target, { timeoutMs: LIST_DIRECTORY_TIMEOUT_MS })
      if (response.result) {
        setNewFolder(null)
        void remoteDirectory.refresh(deviceId, listing.path)
        goTo(response.result.path)
        return
      }
      const code = response.error?.code
      const key =
        code === 'already_exists' ? 'exists'
          : code === 'permission_denied' ? 'permission'
          : code === 'invalid_path' ? 'invalid'
          : code === 'unknown_method' ? 'unsupported'
          : 'unknown'
      if (key === 'unknown') log.warn({ deviceId, target, error: response.error }, 'make-directory failed')
      setNewFolder((current) => current && { ...current, busy: false, error: t(`create.remoteFolders.newFolderError.${key}`) })
    } catch (err) {
      log.warn({ deviceId, target, error: String((err as Error)?.message ?? err) }, 'make-directory threw')
      setNewFolder((current) => current && { ...current, busy: false, error: t('create.remoteFolders.newFolderError.unknown') })
    }
  }, [deviceId, goTo, listing, newFolder, t])

  // ── 选中 ───────────────────────────────────────────────────────────────────
  const canUsePath = !loading && listing !== null
  const choose = useCallback((force = false) => {
    if (!listing || loading) return
    const broad = broadRootKind(listing.path, home)
    if (broad && !force) { setConfirmBroad(broad); return }
    onSelect(listing.path)
  }, [home, listing, loading, onSelect])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (pathDraft !== null || newFolder) return
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel?.()
        return
      }
      // 直接敲 `/` 或 `~` = 开始输入路径(文件选择框的通行做法),⌘L / Ctrl+L 同理。
      if ((event.key === '/' || event.key === '~') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        startEditingPath(event.key)
        return
      }
      if (event.key.toLowerCase() === 'l' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        startEditingPath()
        return
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        choose()
      }
    },
    [choose, newFolder, onCancel, pathDraft, startEditingPath],
  )

  // 打开时焦点落进选择框:否则直接敲 `/home/...` 哪儿也不去(实测),「敲 / 就开始输路径」形同虚设。
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const segments = useMemo(() => pathSegments(listing?.path ?? ''), [listing])
  const visibleEntries = useMemo(() => filterEntries(listing?.entries ?? [], filter), [filter, listing])
  const initialLoading = loading && listing === null
  const selectedPath = listing?.path ?? ''
  const atHome = Boolean(listing && home && listing.path === home)

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('create.remoteFolders.title')}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        // 它总是装在一张 Sheet 里(创建框的「浏览那台机器上的文件夹」):Sheet 已经是那一层浮起的面,
        // 这里 ❌ 再画一圈框 + 一层底色(box inside a box)。行数预算(design.md):只留三段之间的两条分界线
        // (地址栏 | 列表 | 底栏),其余提示条一律是 callout(一条色线 + 密度底),❌ 再各画一条 border。
        'flex h-[420px] max-h-[70dvh] flex-col overflow-hidden outline-none',
      )}
    >
      {/* 地址栏:主目录捷径 · 面包屑(点任意一级回去)· 点空白进入输入 · 刷新 */}
      <div className="relative flex min-h-10 items-center gap-1 border-b border-[var(--border-subtle)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-secondary)]">
        <IconButton
          size="sm"
          aria-label={t('create.remoteFolders.home')}
          title={t('create.remoteFolders.home')}
          onClick={() => goTo('~')}
          disabled={loading || atHome}
          data-testid="remote-folder-home"
        >
          <Home size={14} />
        </IconButton>
        {pathDraft !== null ? (
          <input
            ref={mountPathInput}
            value={pathDraft}
            onChange={(event) => setPathDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                commitPathDraft()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setPathDraft(null)
              } else if (event.key === 'Tab' && suggestions.length > 0) {
                event.preventDefault()
                acceptSuggestion(suggestions[Math.max(0, highlight)])
              } else if (event.key === 'ArrowDown' && suggestions.length > 0) {
                event.preventDefault()
                setHighlight((h) => (h + 1) % suggestions.length)
              } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
                event.preventDefault()
                setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
              }
            }}
            onBlur={() => setPathDraft(null)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="remote-folder-path-suggestions"
            aria-label={t('create.remoteFolders.pathInput')}
            placeholder={t('create.remoteFolders.pathPlaceholder')}
            data-testid="remote-folder-path-input"
            className={cn(
              'min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--accent)] bg-[var(--bg-primary)] px-2 py-1',
              'font-mono text-[length:var(--font-body)] text-[var(--text-primary)] outline-none',
            )}
          />
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-wrap items-center" onClick={(event) => { if (event.target === event.currentTarget) startEditingPath() }}>
              {segments.map((segment, index) => {
                const last = index === segments.length - 1
                return (
                  <span key={`${segment.path}-${index}`} className="inline-flex items-center">
                    {index > 0 && <ChevronRight size={11} color="var(--text-tertiary)" />}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => goTo(segment.path)}
                      disabled={loading}
                      className={cn('min-h-6 px-1', last ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--accent)]')}
                    >
                      {segment.label}
                    </Button>
                  </span>
                )
              })}
              {/*
                点路径条空白处进入输入:整条就是地址栏(照访达 / 资源管理器的地址栏),所以 ❌ 另摆一枚铅笔 ——
                点路径本来就能改,再给一颗钮是同一件事的第二个入口。
                这块空白本身是个按钮:Tab 到它、回车 / 空格也进入输入(另有 `/`、`~`、⌘L 直接开始输)。
              */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => startEditingPath()}
                title={t('create.remoteFolders.pathInput')}
                data-testid="remote-folder-path-blank"
                className="min-h-6 min-w-6 flex-1 self-stretch cursor-text px-0"
              >
                <span className="sr-only">{t('create.remoteFolders.pathInput')}</span>
              </Button>
            </div>
          </>
        )}
        {/* 去不成的原因:留在原地、在地址栏里说清楚、刷新钮换成「重试」(owner 11-08:❌ 横幅 / 列表上方另起一条)。
            手上有读数时列表照常可用。 */}
        {navError && !initialLoading ? (
          <span role="alert" className="flex min-w-0 max-w-[60%] shrink items-center gap-1 text-[length:var(--font-caption)] text-[var(--danger-fg)]">
            <span className="min-w-0 truncate" title={navErrorMessage(navError, t)}>{navErrorMessage(navError, t)}</span>
            <Button variant="ghost" size="sm" className="shrink-0" onClick={retry}>
              {t('create.remoteFolders.retry')}
            </Button>
          </span>
        ) : (
          <IconButton
            size="sm"
            onClick={retry}
            disabled={loading}
            title={t('create.remoteFolders.refresh')}
            aria-label={t('create.remoteFolders.refresh')}
          >
            <RefreshCw size={12} />
          </IconButton>
        )}
        {pathDraft !== null && suggestions.length > 0 ? (
          <ul
            id="remote-folder-path-suggestions"
            role="listbox"
            data-testid="remote-folder-path-suggestions"
            // 浮层公式(docs/design/ui-visual-spec.md §6.3):--radius-surface + 唯一那档 lift,❌ 再叠一圈 border。
            className="absolute top-full right-2 left-9 z-10 m-0 mt-1 list-none rounded-[var(--radius-surface)] bg-[var(--popover)] p-1 shadow-[var(--shadow-lift)]"
          >
            {suggestions.map((entry, index) => (
              <li
                key={entry.name}
                role="option"
                aria-selected={index === highlight}
                // mousedown 而不是 click:click 之前输入框先失焦,草稿就被收掉了。
                onMouseDown={(event) => { event.preventDefault(); acceptSuggestion(entry) }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-primary)]',
                  index === highlight ? 'bg-[var(--selected)]' : 'hover:bg-[var(--hover)]',
                )}
              >
                <span className="inline-flex text-[var(--accent)]">{entryIcon(entry.kind)}</span>
                <span className="truncate font-mono">{entry.name}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {/* Completion could not list that folder: no suggestions, and why (❌ an empty list that reads as "nothing there"). */}
        {completionError ? (
          <span role="status" data-testid="remote-folder-path-completion-error" className="absolute top-full right-2 left-9 z-10 mt-1 truncate rounded-[var(--radius-surface)] bg-[var(--popover)] px-2 py-1 text-[length:var(--font-caption)] text-[var(--danger-fg)] shadow-[var(--shadow-lift)]">
            {navErrorMessage(completionError, t)}
          </span>
        ) : null}
      </div>

      {/* 工具条:筛选这个文件夹 · 新建文件夹 */}
      {listing ? (
        <div className="flex items-center gap-2 px-2 py-2">
          <SearchField
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('create.remoteFolders.filterPlaceholder')}
            clearLabel={t('create.remoteFolders.filterClear')}
            onClear={() => setFilter('')}
            className="h-7"
            data-testid="remote-folder-filter"
          />
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={loading || newFolder !== null}
            onClick={() => setNewFolder({ name: '', busy: false, error: null })}
            data-testid="remote-folder-new"
          >
            <FolderPlus size={14} />
            {t('create.remoteFolders.newFolder')}
          </Button>
        </div>
      ) : null}

      {truncatedCount !== null && (
        <div role="status" className="mx-2 mb-1 border-l-2 border-[var(--warn)] bg-foreground/[0.025] px-2 py-1 text-[length:var(--font-caption)] text-[var(--text-secondary)] dark:bg-foreground/[0.04]">
          {t('create.remoteFolders.truncated', { count: truncatedCount })}
        </div>
      )}

      <div className={cn('relative flex-1 overflow-auto', loading && listing && 'opacity-60')}>
        {initialLoading ? (
          <div className="absolute inset-0 flex items-center justify-center px-3 py-3 text-[var(--text-secondary)]">
            {/* 在连那台机器:全产品唯一的加载态(product spec),计秒写在它下面那行字里。 */}
            <LoadingIndicator
              ariaLabel={t('create.remoteFolders.connecting', { seconds: loadElapsed })}
              label={t('create.remoteFolders.connecting', { seconds: loadElapsed })}
            />
          </div>
        ) : null}
        {newFolder ? (
          <div className="flex flex-col gap-1 px-2 py-2">
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newFolder.name}
                disabled={newFolder.busy}
                onChange={(event) => setNewFolder({ ...newFolder, name: event.target.value, error: null })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submitNewFolder() }
                  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNewFolder(null) }
                }}
                spellCheck={false}
                aria-label={t('create.remoteFolders.newFolder')}
                placeholder={t('create.remoteFolders.newFolderPlaceholder')}
                data-testid="remote-folder-new-name"
                className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--accent)] bg-[var(--bg-primary)] px-2 py-1 text-[length:var(--font-body)] text-[var(--text-primary)] outline-none"
              />
              <Button variant="primary" size="sm" disabled={newFolder.busy} onClick={() => void submitNewFolder()}>
                {newFolder.busy ? <LoadingIndicator size="inline" /> : null}
                {t('create.remoteFolders.newFolderCreate')}
              </Button>
              <Button variant="ghost" size="sm" disabled={newFolder.busy} onClick={() => setNewFolder(null)}>
                {t('common.cancel')}
              </Button>
            </div>
            {newFolder.error ? (
              <span role="alert" className="text-[length:var(--font-caption)] text-[var(--danger-fg)]">{newFolder.error}</span>
            ) : null}
          </div>
        ) : null}
        {listing && !initialLoading && listing.entries.length === 0 ? (
          <div className="px-3 py-3 text-[length:var(--font-body)] text-[var(--text-tertiary)]">{t('create.remoteFolders.empty')}</div>
        ) : null}
        {listing && listing.entries.length > 0 && visibleEntries.length === 0 ? (
          <div className="px-3 py-3 text-[length:var(--font-body)] text-[var(--text-tertiary)]">
            {t('create.remoteFolders.filterNoMatch', { query: filter.trim() })}
          </div>
        ) : null}
        {listing ? (
          <ul className="m-0 list-none p-1">
            {visibleEntries.map((entry) => {
              const enterable = isEnterable(entry)
              return (
                <li key={entry.name}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { if (enterable) goTo(joinPath(listing.path, entry.name)) }}
                    disabled={!enterable || loading}
                    className={cn(
                      'w-full justify-start gap-2 px-2 font-normal',
                      enterable ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                    )}
                  >
                    <span className={cn('inline-flex items-center', enterable ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
                      {entryIcon(entry.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>

      {/* 选根目录 / 主目录本身当项目:先问一句(Zed 同样提醒「别开太大的目录」)。 */}
      {confirmBroad ? (
        <div role="alert" data-testid="remote-folder-broad-confirm" className="mx-2 mb-2 flex flex-wrap items-center gap-2 border-l-2 border-[var(--warn)] bg-foreground/[0.025] px-3 py-2 text-[length:var(--font-body)] text-[var(--text-primary)] dark:bg-foreground/[0.04]">
          <span className="min-w-0 flex-1">
            {t(confirmBroad === 'root' ? 'create.remoteFolders.broadRoot' : 'create.remoteFolders.broadHome')}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setConfirmBroad(null)}>
            {t('create.remoteFolders.broadPickAnother')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => choose(true)} data-testid="remote-folder-broad-use">
            {t('create.remoteFolders.broadUseAnyway')}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] px-2 py-2 text-[length:var(--font-caption)] text-[var(--text-tertiary)]">
        <label className="inline-flex cursor-pointer items-center gap-1">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => {
              setShowHidden(event.target.checked)
              navigate(listing?.path ?? current.path, event.target.checked)
            }}
            className="m-0"
          />
          {t('create.remoteFolders.showHidden')}
        </label>
        <span className="whitespace-nowrap">
          {loading ? t('create.remoteFolders.loading') : listing ? t('create.remoteFolders.itemCount', { count: listing.entries.length }) : ''}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]" title={selectedPath}>
          {selectedPath}
        </span>
        {onCancel && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={() => choose()} disabled={!canUsePath}>
          {t('create.remoteFolders.use')}
        </Button>
      </div>
    </div>
  )
}
