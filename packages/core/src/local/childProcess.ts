import * as nodeChildProcess from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

/**
 * The only place product code starts child processes. Same API as `node:child_process`, with one
 * difference: `windowsHide` defaults to `true`.
 *
 * On Windows the desktop app, its utility processes and the task host have no console of their
 * own, so every console program they start (git, where, tmux, reg, taskkill, an agent CLI…) gets a
 * brand-new console window unless the spawn asks for it hidden — a black box that flashes for as
 * long as the child lives. Hiding it at the root also covers the child's own children, which
 * inherit its (hidden) console. Everywhere else the flag is a no-op.
 *
 * A call that starts a program whose window the person should see (opening an app or a terminal)
 * says so with an explicit `windowsHide: false`.
 */

type Rest = unknown[]

const isOptions = (value: unknown): value is object => typeof value === 'object' && value !== null && !Array.isArray(value)

/** `rest` = everything after the command; `at` = where the options object sits when present. */
function hidden(rest: Rest, at: number): Rest {
  const out = [...rest]
  const value = out[at]
  if (isOptions(value)) out[at] = { windowsHide: true, ...value }
  else if (value === undefined || value === null) out[at] = { windowsHide: true }
  else out.splice(at, 0, { windowsHide: true }) // a callback where the options would go
  return out
}

/** `(file, args?, options?, ...)`: options come after the args array when there is one. */
const fileStyle = (rest: Rest): Rest => hidden(rest, Array.isArray(rest[0]) || (rest[0] === undefined && rest.length > 1) ? 1 : 0)
/** `(command, options?, ...)`. */
const shellStyle = (rest: Rest): Rest => hidden(rest, 0)

type AnyFn = (...args: never[]) => unknown
const call = (fn: AnyFn, first: unknown, rest: Rest): unknown => (fn as (...args: unknown[]) => unknown)(first, ...rest)

export const spawn = ((command: unknown, ...rest: Rest) =>
  call(nodeChildProcess.spawn, command, fileStyle(rest))) as typeof nodeChildProcess.spawn
export const spawnSync = ((command: unknown, ...rest: Rest) =>
  call(nodeChildProcess.spawnSync, command, fileStyle(rest))) as typeof nodeChildProcess.spawnSync
export const execFileSync = ((file: unknown, ...rest: Rest) =>
  call(nodeChildProcess.execFileSync, file, fileStyle(rest))) as typeof nodeChildProcess.execFileSync
export const fork = ((modulePath: unknown, ...rest: Rest) =>
  call(nodeChildProcess.fork, modulePath, fileStyle(rest))) as typeof nodeChildProcess.fork
export const execSync = ((command: unknown, ...rest: Rest) =>
  call(nodeChildProcess.execSync, command, shellStyle(rest))) as typeof nodeChildProcess.execSync

// `execFile` / `exec` carry a custom promisified form that resolves `{ stdout, stderr }`; keep it.
export const execFile = Object.assign(
  (file: unknown, ...rest: Rest) => call(nodeChildProcess.execFile, file, fileStyle(rest)),
  { [promisify.custom]: (file: unknown, ...rest: Rest) => call(promisify(nodeChildProcess.execFile), file, fileStyle(rest)) },
) as unknown as typeof nodeChildProcess.execFile
export const exec = Object.assign(
  (command: unknown, ...rest: Rest) => call(nodeChildProcess.exec, command, shellStyle(rest)),
  { [promisify.custom]: (command: unknown, ...rest: Rest) => call(promisify(nodeChildProcess.exec), command, shellStyle(rest)) },
) as unknown as typeof nodeChildProcess.exec

/**
 * Absolute path of a program that ships with Windows, e.g. `windowsSystemProgram('reg.exe')` or
 * `windowsSystemProgram('WindowsPowerShell\\v1.0\\powershell.exe')`.
 *
 * Start Windows' own programs by this path, never by bare name: other software can corrupt the
 * system PATH (a user's `%SystemRoot%\system32` entry came back garbled), and a bare `reg` then
 * fails with `spawn reg ENOENT`. `SystemRoot` is its own variable and is not touched by that. It
 * also keeps a same-named program earlier on PATH from standing in for the system one.
 */
export function windowsSystemProgram(relative: string, env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', relative)
}
