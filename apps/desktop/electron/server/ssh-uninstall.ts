/**
 * #6264「设置 → 设备 → 从这台机器上卸载咕咕 server」(只给用 SSH 装上的机器):经同一条 SSH 连过去,
 * 任务归档后，停止服务并撤销登录，保留服务器原位的账号数据供重装使用。
 *
 * 两段式,中间停下来等人确认:
 *  ① 看一眼 —— 装的哪个版本、这台机器上登着哪些账号(卸载会让他们一起用不了,确认页要点名);
 *  ② 人确认后才卸 —— 服务注销、server 停下、各账号的 tmux 终端服务端收掉、安装目录与两个软链删掉。
 * 项目文件夹不在咕咕的目录里,不碰。
 *
 * 纯逻辑(脚本、解析)与编排(注入 spawn ssh)都在这里,单测把整条状态机走一遍;接 Electron 的在 ssh-uninstall-ipc.ts。
 */
import type {
  ServerUninstallAccount,
  ServerUninstallInspection,
  ServerUninstallState,
} from '../../src/lib/serverSshMachines'
import type { ServerSshInstallPrompt } from '../../src/lib/serverSshInstall'
import { buildSshArgs, classifySshFailure, lastLines, type SshTarget } from './ssh-install/logic'
import type { SpawnSsh, SshRunResult } from './ssh-install/runner'
import { desktopServerChannel, remoteServerPaths, SERVER_LOGIN_REVOKED, serverNames, UNINSTALL_ARCHIVE_RECEIPT } from './server-names'
import { verifiedUninstallProcessesScript } from './ssh-uninstall-processes'

export const INSPECT_BEGIN = '__GUGU_UNINSTALL_PROBE_BEGIN__'
export const INSPECT_END = '__GUGU_UNINSTALL_PROBE_END__'
export const UNINSTALLED_MARK = '__GUGU_UNINSTALLED__'
const REVOKE_FAILED_MARK = '__GUGU_UNINSTALL_REVOKE_FAILED__'

/** 卸的是这台桌面那条通道的 server(server-names.ts),同一个用户下别的通道的那份不碰。 */
const { home: SERVER_HOME, bin: SERVER_BIN } = remoteServerPaths(desktopServerChannel())

// install.sh can preserve an older home under a newer channel's command name.
// Read its literal assignment; never evaluate the launcher's shell contents.
const installationPaths = [
  `B=${SERVER_BIN}`,
  `H=${SERVER_HOME}`,
  'PINNED="$(sed -n \'s/^GUGU_SERVER_HOME="\\([^"]*\\)" exec .*/\\1/p\' "$B" 2>/dev/null | head -n 1)"',
  'case "$PINNED" in /*) H="$PINNED" ;; esac',
  'CLI="$H/current/bin/gugu-server"',
  'export GUGU_SERVER_HOME="$H"',
  `READY="$H/${UNINSTALL_ARCHIVE_RECEIPT}"`,
]

/** 看一眼:装没装、哪个版本、登着哪些账号(账号 id、有没有登录态、邮箱)。输出夹在两行标记之间。 */
export function inspectScript(): string {
  return [
    `echo ${INSPECT_BEGIN}`,
    ...installationPaths,
    'if [ -x "$CLI" ] || [ -e "$B" ] || [ -L "$B" ]; then echo installed=1; fi',
    'if { [ -x "$CLI" ] && "$CLI" help 2>/dev/null | grep -q "gugu-server revoke-login"; } || { [ ! -x "$CLI" ] && [ -f "$READY" ]; }; then echo supported=1; fi',
    'printf "home=%s\\n" "$H"',
    'if [ -f "$READY" ]; then printf "archived=%s\\n" "$(head -n 1 "$READY")"; fi',
    'echo "version=$(cat "$H/current/version" 2>/dev/null)"',
    'for d in "$H/account" "$H"/accounts/*/ "$H"/retired/*/; do',
    '  [ -L "${d%/}" ] && continue',
    '  [ -f "$d/account.json" ] || continue',
    '  id="$(sed -n \'s/.*"userId": *"\\([^"]*\\)".*/\\1/p\' "$d/account.json" 2>/dev/null | head -n 1)"; [ -n "$id" ] || id="$(basename "$d")"',
    '  s=0; [ -f "$d/data/server-session.enc" ] && s=1',
    '  e="$(sed -n \'s/.*"email": *"\\([^"]*\\)".*/\\1/p\' "$d/account.json" | head -n 1)"',
    '  echo "account=$id $s $e"',
    'done',
    `echo ${INSPECT_END}`,
    '',
  ].join('\n')
}

export type InspectedAccount = { userId: string; signedIn: boolean; email: string | null }
export type InspectResult = { installed: boolean; supported: boolean; home: string | null; archivedFor: string | null; version: string | null; accounts: InspectedAccount[] }

export function parseInspectOutput(stdout: string): InspectResult | null {
  const begin = stdout.lastIndexOf(INSPECT_BEGIN)
  const end = stdout.indexOf(INSPECT_END, begin)
  if (begin < 0 || end < 0) return null
  let installed = false
  let supported = false
  let home: string | null = null
  let archivedFor: string | null = null
  let version: string | null = null
  const accounts: InspectedAccount[] = []
  for (const raw of stdout.slice(begin + INSPECT_BEGIN.length, end).split(/\r?\n/)) {
    const line = raw.trim()
    if (line === 'installed=1') installed = true
    else if (line === 'supported=1') supported = true
    else if (line.startsWith('home=/')) home = line.slice('home='.length)
    else if (line.startsWith('archived=')) archivedFor = line.slice('archived='.length)
    else if (line.startsWith('version=')) version = line.slice('version='.length).trim() || null
    else if (line.startsWith('account=')) {
      const [userId, signed, ...rest] = line.slice('account='.length).split(' ')
      if (!userId) continue
      accounts.push({ userId, signedIn: signed === '1', email: rest.join(' ').trim() || null })
    }
  }
  return { installed, supported, home, archivedFor, version, accounts }
}

/** 给确认页的清单:登着的在前、你自己排第一;没登录态的账号(退出过的)也列出来，卸载会保留它的数据。 */
export function toInspection(result: InspectResult, currentUserId: string | null): ServerUninstallInspection {
  const accounts: ServerUninstallAccount[] = result.accounts
    .map((account) => ({ email: account.email, signedIn: account.signedIn, you: account.userId === currentUserId }))
    .sort((a, b) => Number(b.you) - Number(a.you) || Number(b.signedIn) - Number(a.signedIn))
  return { installed: result.installed, supported: result.supported, home: result.home,
    archiveReady: Boolean(currentUserId && result.archivedFor === currentUserId), version: result.version, accounts }
}

/** The archive is confirmed by the desktop before this script can stop the host. */
export function uninstallScript(userId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new UninstallFailure('revokeFailed')
  return [
    ...installationPaths,
    `OWNER='${userId}'`,
    `revoke_failed() { echo '${REVOKE_FAILED_MARK}' >&2; exit 1; }`,
    'if [ -x "$CLI" ]; then',
    'account=',
    'for d in "$H/account" "$H"/accounts/*/ "$H"/retired/*/; do',
    '  [ -L "${d%/}" ] && continue',
    '  [ -f "$d/account.json" ] || continue',
    '  id="$(sed -n \'s/.*"userId": *"\\([^"]*\\)".*/\\1/p\' "$d/account.json" | head -n 1)"',
    '  if [ "${d%/}" = "$H/account" ]; then account="$id"; fi',
    '  if [ -f "$d/data/server-session.enc" ] && { [ "${d%/}" != "$H/account" ] || [ "$id" != "$OWNER" ]; }; then revoke_failed; fi',
    'done',
    'if [ -n "$account" ] && [ "$account" != "$OWNER" ]; then revoke_failed; fi',
    verifiedUninstallProcessesScript(),
    // A failure or dropped reply after this point can be retried from SSH while the task host is stopped.
    'if [ "$(head -n 1 "$READY" 2>/dev/null)" != "$OWNER" ]; then',
    '  if ! (umask 077; printf "%s\\n" "$OWNER" > "$READY"); then exit 1; fi',
    'fi',
    'if [ -n "$account" ]; then',
    '  if ! o="$("$CLI" revoke-login "$OWNER" </dev/null)"; then revoke_failed; fi',
    `  printf "%s\\n" "$o" | grep -Fxq "${SERVER_LOGIN_REVOKED}" || revoke_failed`,
    'fi',
    'if ! "$CLI" service uninstall </dev/null; then exit 1; fi',
    'T="$H/current/app/tmux-bundle/tmux"; [ -x "$T" ] || T=tmux',
    'for d in "$H/account" "$H"/accounts/*/ "$H"/retired/*/; do',
    '  [ -L "${d%/}" ] && continue',
    '  [ -d "$d" ] || continue',
    '  id="$(sed -n \'s/.*"userId": *"\\([^"]*\\)".*/\\1/p\' "$d/account.json" 2>/dev/null | head -n 1)"; [ -n "$id" ] || id="$(basename "$d")"',
    `  "$T" -L "${serverNames(desktopServerChannel()).bin}-$(printf %s "$id" | cut -c1-8)" kill-server >/dev/null 2>&1`,
    'done',
    'elif [ "$(head -n 1 "$READY" 2>/dev/null)" != "$OWNER" ]; then',
    '  exit 1',
    'fi',
    'rm -rf "$H/current" "$H/versions" || exit 1',
    `for l in ${['stable', 'beta'].map(channel => `"$HOME/.local/bin/${serverNames(channel).bin}"`).join(' ')} "$HOME/.local/bin/node" ${SERVER_HOME}; do`,
    '  remove=0',
    '  if [ -L "$l" ]; then case "$(readlink "$l")" in "$H"|"$H"/*) remove=1 ;; esac',
    '  elif [ -f "$l" ] && grep -qF "GUGU_SERVER_HOME=\\"$H\\"" "$l"; then remove=1; fi',
    '  if [ "$remove" = 1 ]; then',
    '    rm -f "$l"',
    '    if [ -e "$l" ] || [ -L "$l" ]; then echo "卸载失败:删不掉 $l" >&2; exit 1; fi',
    '  fi',
    'done',
    'rm -f "$READY" || exit 1',
    `echo ${UNINSTALLED_MARK}`,
    '',
  ].join('\n')
}

export type UninstallDeps = {
  spawnSsh: SpawnSsh
  controlPath: string | null
  /** 桌面此刻登着的账号,用来在清单里标「你」。 */
  currentUserId: string | null
  /** 人确认并完成任务归档后，才能停止和卸载服务器。 */
  waitForConfirm: () => Promise<boolean>
  signal: AbortSignal
}

class UninstallFailure extends Error {
  constructor(
    readonly reason: NonNullable<ServerUninstallState['failure']>['reason'],
    readonly detail?: string,
  ) {
    super(reason)
  }
}

/** 一次卸载的状态;快照每变一次整份推给界面。 */
export class UninstallRun {
  private state: ServerUninstallState

  constructor(
    runId: string,
    deviceId: string,
    target: string,
    private readonly emit: (state: ServerUninstallState) => void,
  ) {
    this.state = { runId, deviceId, target, phase: 'inspecting', prompt: null, inspection: null, failure: null }
  }

  snapshot(): ServerUninstallState {
    return this.state
  }

  update(mutate: (draft: ServerUninstallState) => void): void {
    const draft = structuredClone(this.state)
    mutate(draft)
    this.state = draft
    this.emit(draft)
  }

  setPrompt(prompt: ServerSshInstallPrompt | null): void {
    this.update((draft) => {
      draft.prompt = prompt
    })
  }
}

export async function runSshUninstall(target: SshTarget, run: UninstallRun, deps: UninstallDeps): Promise<ServerUninstallState> {
  const args = buildSshArgs(target, { controlPath: deps.controlPath })
  const ssh = async (stdin: string): Promise<SshRunResult> => {
    if (deps.signal.aborted) throw new UninstallFailure('cancelled')
    let result: SshRunResult
    try {
      result = await deps.spawnSsh(args, { stdin, signal: deps.signal })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new UninstallFailure('sshMissing')
      throw new UninstallFailure('unknown', error instanceof Error ? error.message : String(error))
    }
    if (deps.signal.aborted) throw new UninstallFailure('cancelled')
    if (result.code === 255) throw new UninstallFailure(classifySshFailure(result.stderr), lastLines(result.stderr))
    return result
  }

  try {
    const inspected = await ssh(inspectScript())
    const parsed = parseInspectOutput(inspected.stdout)
    if (!parsed) throw new UninstallFailure('unknown', lastLines(`${inspected.stdout}\n${inspected.stderr}`))
    const inspection = toInspection(parsed, deps.currentUserId)
    run.update((draft) => {
      draft.prompt = null
      draft.inspection = inspection
      draft.phase = 'confirm'
    })
    if (!(await deps.waitForConfirm())) throw new UninstallFailure('cancelled')
    if (!deps.currentUserId || !inspection.supported) throw new UninstallFailure('updateRequired')
    run.update((draft) => {
      draft.phase = 'uninstalling'
    })
    const removed = await ssh(uninstallScript(deps.currentUserId))
    if (removed.code !== 0 || !removed.stdout.split(/\r?\n/).includes(UNINSTALLED_MARK)) {
      if (removed.stderr.split(/\r?\n/).includes(REVOKE_FAILED_MARK)) throw new UninstallFailure('revokeFailed')
      const own = removed.stderr.split(/\r?\n/).reverse().find((line) => line.startsWith('卸载失败'))
      throw new UninstallFailure('uninstallFailed', own ?? lastLines(`${removed.stdout}\n${removed.stderr}`))
    }
    run.update((draft) => {
      draft.prompt = null
      draft.phase = 'done'
    })
  } catch (error) {
    const failure = error instanceof UninstallFailure ? error : new UninstallFailure('unknown', error instanceof Error ? error.message : String(error))
    run.update((draft) => {
      draft.prompt = null
      draft.phase = failure.reason === 'cancelled' ? 'cancelled' : 'failed'
      draft.failure = failure.reason === 'cancelled' ? null : { reason: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}) }
    })
  }
  return run.snapshot()
}
