import type { TranscriptTurn } from '@gugu/session-core/acp'

export const previewAgent = 'user:11111111-1111-4111-8111-111111111111'
export const previewOwner = 'user:22222222-2222-4222-8222-222222222222'
export const previewBody = 'Process someone@example.com'

/** Actual transcript input/output shapes; no precomputed fold metadata. */
export function foldedPreviewTurn(kind: 'received' | 'group' | 'agent' | 'owner' | 'failed' = 'group'): TranscriptTurn {
  const delivery = `<gugu_delivery route="chat" from="Worker" from_id="${previewAgent}" from_type="agent" chat="group" chat_kind="group" msg="msg:6417511d-8f36-4cbc-8cbb-81ce9f97df72"><![CDATA[someone@example.com]]></gugu_delivery>`
  return {
    id: 'turn', seq: 0, initiator: 'user', trigger: { kind: kind === 'received' ? 'delivery' : 'owner' },
    startedAt: 1000, endedAt: 3000, outcome: { kind: 'done', reason: 'end_turn' },
    items: [
      { kind: 'message', id: 'input', seq: 0, role: 'user', text: kind === 'received' ? delivery : 'Owner request', at: 1000 },
      ...(kind === 'received' ? [] : [{ kind: 'message' as const, id: 'narration', seq: 1, role: 'assistant' as const, text: previewBody, at: 2000 }]),
      ...(kind === 'received' ? [] : [{
        kind: 'mcp-tool-call' as const, id: 'send', toolCallId: 'send', seq: 2, title: 'Send', tool: 'message_send', server: 'gugu',
        status: kind === 'failed' ? 'error' as const : 'done' as const,
        rawInput: JSON.stringify({ chat_id: kind === 'owner' ? 'direct' : 'group',
          ...(kind === 'owner' || kind === 'agent' ? { to_user_ids: [kind === 'owner' ? previewOwner : previewAgent] } : {}), text: previewBody }),
        outputText: kind === 'failed' ? 'Permission denied' : 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)',
      }]),
    ],
  }
}
