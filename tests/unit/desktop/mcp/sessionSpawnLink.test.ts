/**
 * Owner 2026-11-15: session_spawn hands back the link an agent pastes in chat to mention the new session (it opens on a
 * click; `session:<id>` is the tools' address). Only session_spawn: it is rarely called, the others would pay it in context.
 */
import { describe, expect, it } from 'vitest'
import { SESSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'
import { registerSessionpageTools } from '../../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'
import { parseGuguLink } from '@gugu/core/shared/ui/guguLink'

const SESSION = 'f531076b-76ad-4186-b6b0-e5f0d8963dba'

async function call(name: string, args: Record<string, unknown>, answer: unknown) {
  let run: ((args: unknown, extra: { signal: AbortSignal }) => Promise<{ content: { text: string }[] }>) | undefined
  const def = SESSION_TOOL_DEFS.find((item) => item.name === name)!
  registerSessionpageTools({ registerTool: (_name: string, _options: unknown, handler: typeof run) => { run = handler } } as never,
    [def], async () => answer, () => 'unavailable', (async (work: Promise<unknown>) => work) as never)
  return JSON.parse((await run!(args, { signal: new AbortController().signal })).content[0]!.text)
}

describe('session_spawn returns a session link', () => {
  it('carries session_link beside session_id, a link that opens that session', async () => {
    const spawned = await call('session_spawn', { prompt: 'go' }, { session_id: SESSION, model: 'opus' })
    expect(spawned).toEqual({ session_id: `session:${SESSION}`, session_link: `gugu://session/${SESSION}`, model: 'opus' })
    expect(parseGuguLink(spawned.session_link)).toEqual({ kind: 'session', sessionId: SESSION })
  })

  it('leaves session_get without one', async () => {
    expect(await call('session_get', {}, { session_id: SESSION })).toEqual({ session_id: `session:${SESSION}` })
  })
})
