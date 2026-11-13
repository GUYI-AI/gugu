import { expect, it } from 'vitest'
import { workspaceFileText, workspaceUploadKind } from '@gugu/core/shared/workspaceUpload.mjs'

it('preserves BOM bytes in extensionless text files', () => { const bytes = new TextEncoder().encode('\ufeffhello'); const result = workspaceFileText('README', bytes)!; expect(new TextEncoder().encode(result.text)).toEqual(bytes) ; expect(workspaceUploadKind('board.json', null, new TextEncoder().encode('\ufeff{"ok":true}')).kind).toBe('document') })
