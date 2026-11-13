import { expect, it } from 'vitest'
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels'
import { formatVoiceAttachmentMetadata, parseVoiceAttachmentContent } from '@gugu/core/shared/ui/voiceAttachmentModels'
import { workspaceStoredText, workspaceUploadKind } from '@gugu/core/shared/workspaceUpload.mjs'
import { parseCsv } from '../../../../apps/desktop/src/session/renderer/lib/editor/csv-parser'


it('keeps attachment captions from CRLF envelopes', () => {
  const content = '[附件] note.txt (text/plain)\r\n[Size] 10\r\n[Kind] file\r\n[Caption]\r\nFirst\r\nSecond'
  expect(parseAttachmentContent(content)?.caption).toBe('First\nSecond')
})


it('round-trips multiline voice attachment transcriptions', () => {
  const body = formatVoiceAttachmentMetadata(1500, 'First\nSecond')
  expect(parseVoiceAttachmentContent('[附件] voice.webm (audio/webm)\n' + body)?.transcript).toBe('First\nSecond')
})


it('keeps NUL-containing UTF-8 bytes out of editable text documents', () => {
  const bytes = new TextEncoder().encode('header\0payload')
  expect(workspaceStoredText('note.txt', null, bytes)).toBeNull()
  expect(workspaceUploadKind('note.txt', null, bytes).kind).toBe('file')
})



it('retains UTF-8 BOM bytes in text marked exact', () => {
  const bytes = new TextEncoder().encode('\ufeff# Note')
  const stored = workspaceStoredText('note.md', null, bytes)!
  expect(stored.exact).toBe(true)
  expect(new TextEncoder().encode(stored.text)).toEqual(bytes)
})


it('retains a final quoted empty CSV cell without a trailing newline', () => {
  expect(parseCsv('""').rows).toEqual([['']])
  expect(parseCsv('id\n""').rows).toEqual([['id'], ['']])
  expect(parseCsv('').rows).toEqual([])
})


it('ignores the CSV BOM before a quoted first header', () => {
  expect(parseCsv('\ufeff"first",second\n1,2').rows).toEqual([['first', 'second'], ['1', '2']])
  expect(parseCsv('first,\ufeffsecond').rows).toEqual([['first', '\ufeffsecond']])
})



it('reads CRLF voice attachment envelopes', () => { expect(parseVoiceAttachmentContent('[附件] voice.webm (audio/webm)\r\n[语音] durationMs=1500\r\n[转写] Hello\r\nSecond')?.transcript).toBe('Hello\nSecond') })
