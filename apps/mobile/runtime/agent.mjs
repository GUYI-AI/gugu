import { createJsonlReader } from '../../../packages/core/src/local/jsonl.mjs'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTurn, cancelTurn } from './pi-session.mjs'
import { startPhoneAgentHost } from './phone-agent-host.mjs'
import { createNativeBridge } from './native-bridge.mjs'
import { configureNodeNetwork } from '../../../packages/core/src/local/node-network.mjs'
import { bindAgentEntry, createAgentEntry } from './agent-entry.mjs'
import { installEgress, runtimeEgress } from '../../../packages/core/src/shared/egress.ts'
import { drawImagePreviews } from '../../../packages/core/src/cloud/attachmentsApi.ts'
import { nodeImagePreview } from '../../../packages/core/src/local/files/nodeImagePreview.ts'

configureNodeNetwork()
installEgress(runtimeEgress())
// Every image this phone's agents send offers a preview, drawn with sharp (its wasm32 build here), as on the headless server.
drawImagePreviews({ draw: nodeImagePreview, warn: (error) => process.stderr.write(`Image preview offer failed: ${error instanceof Error ? error.message : String(error)}\n`) })
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
const bridge = createNativeBridge(output)
const entry = createAgentEntry({ runTurn, cancelTurn, startPhoneAgentHost, bridge, output })

const input = createJsonlReader({ input: process.stdin })
process.stderr.on('error', () => { process.exitCode = 1 })
bindAgentEntry(entry, {
  input, output: process.stdout,
  onClosed: () => process.exit(process.exitCode ?? 0),
  onError: (error) => {
    process.exitCode = 1
    process.stderr.write(`手机运行时关闭失败：${error.message}\n`)
  },
  onTimeout: (failure) => {
    const record = { type: 'unclean_shutdown', ...failure, at: new Date().toISOString(), pid: process.pid }
    try {
      if (!process.env.GUGU_AGENT_HOME) throw new Error('GUGU_AGENT_HOME is not configured')
      appendFileSync(join(process.env.GUGU_AGENT_HOME, 'runtime-shutdown.jsonl'), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flush: true })
    } catch (error) { process.stderr.write(`手机运行时未能记录非优雅退出：${error.message}\n`) }
    finally {
      // The only native parent channel is gone; a later host recovers running jobs as interrupted.
      process.exit(1)
    }
  },
})
output({ type: 'ready', node: process.version, platform: process.platform, arch: process.arch })
