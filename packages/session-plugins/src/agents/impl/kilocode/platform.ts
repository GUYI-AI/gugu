import type { HarnessPlatform } from '@gugu/session-core/agents/plugins'

/**
 * Same topology as OpenCode: the config document enters the ACP adapter or the host-owned `kilo serve`
 * through its spawn env, and `kilo attach` only renders. Kilo 7.8.27 sends `@ai-sdk/openai` to `/v1/responses`.
 */
export const harnessPlatform = {
  kind: 'supported',
  wireProtocol: 'openai-responses',
  dialect: 'kilocode-config-content',
  injection: {
    tui: {
      credentialSinks: [{ process: 'detachedInference', carrier: 'spawnEnvConfigDocument' }],
      tokenLifetime: 'detachedInference',
      tokenReuseProbe: 'liveInferenceProcess',
      modelSlots: ['main'],
      wired: true,
    },
    cui: {
      credentialSinks: [{ process: 'acpAdapter', carrier: 'spawnEnvConfigDocument' }],
      tokenLifetime: 'acpAdapterProcess',
      tokenReuseProbe: 'heldRecord',
      modelSlots: ['main'],
      wired: true,
    },
  },
} as const satisfies HarnessPlatform
