import type { SessionpageSessionCreateModelChoice } from '@gugu/session-core/session-record/contract'

// Readable native rows copied verbatim from the production Codex modelOptions in
// packages/session-plugins/src/agents/impl/codex/index.ts at dev 661a3cf31ed4acd7e2cf69f28b72d3a3d9d0b0ee.
// This is a production metadata snapshot, not a live CLI/account inventory.
// Keep raw CLI IDs and separate names/descriptions. Pressure aliases stay in
// their original internal-only cases; never use them for delivery screenshots.
export const normalCodexModelRows: SessionpageSessionCreateModelChoice[] = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: 'Flagship GPT-5.6 model for the hardest agentic coding workflows.', source: 'harness' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'Balanced GPT-5.6 model for everyday coding work with lower cost.', source: 'harness' },
]
export const normalCodexSelectedId = normalCodexModelRows[0]!.id
export const normalCodexAlternativeId = normalCodexModelRows[1]!.id
