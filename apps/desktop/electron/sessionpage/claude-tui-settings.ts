import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { claudeSessionFlagSettings } from '@gugu/session-plugins/agents'
import { writeSessionSettingsFile } from './session-settings-file'
import { registerSessionpageSessionRuntime } from './sessionpage-session-runtime-registry'

export const CLAUDE_TUI_BASE_SETTINGS = { disableAgentView: true, skipDangerousModePermissionPrompt: true } as const

const ownedFiles = new Map<string, Set<string>>()

export async function releaseClaudeTuiSettings(sessionId: string): Promise<void> {
  const files = ownedFiles.get(sessionId)
  ownedFiles.delete(sessionId)
  if (files) await Promise.all([...files].map((file) => rm(file, { force: true })))
}
registerSessionpageSessionRuntime({ name: 'claude-tui-settings', teardown: releaseClaudeTuiSettings })

function splitSettings(args: readonly string[]): { args: string[]; last?: string } {
  const rest: string[] = []
  let last: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--settings') {
      if (args[i + 1] === undefined) throw new Error('Claude --settings has no value')
      last = args[++i]
    } else if (args[i].startsWith('--settings=')) last = args[i].slice('--settings='.length)
    else rest.push(args[i])
  }
  return { args: rest, last }
}

/** Preserve the CLI's last-settings semantics, then overlay only this session's flags. */
export async function claudeTuiSessionArgs(input: {
  sessionId: string; cwd: string; baseArgs: readonly string[]; extraArgs: readonly string[];
  userSettingsProvided: boolean; platformSettingsPath: string | null;
  fastMode: boolean; effort?: string;
}): Promise<string[]> {
  const base = splitSettings(input.baseArgs)
  const extra = splitSettings(input.extraArgs)
  // Ownership is supplied by buildCommand's caller, never guessed from a JSON key.
  const source = input.platformSettingsPath ?? (input.userSettingsProvided ? base.last : undefined)
  const parsed: unknown = source
    ? JSON.parse(source.trim().startsWith('{') ? source : await readFile(resolve(input.cwd, source), 'utf8'))
    : { ...CLAUDE_TUI_BASE_SETTINGS }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude settings must be an object')
  const document = {
    ...parsed,
    ...claudeSessionFlagSettings({ fastMode: input.platformSettingsPath ? false : input.fastMode, reasoningEffort: input.effort }),
  }
  let path = input.platformSettingsPath
  if (path) {
    // This is the host's protected session document, never the user's file.
    await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  } else {
    path = await writeSessionSettingsFile(document)
    const files = ownedFiles.get(input.sessionId) ?? new Set<string>()
    files.add(path); ownedFiles.set(input.sessionId, files)
  }
  return [...base.args, ...extra.args, '--settings', path]
}
