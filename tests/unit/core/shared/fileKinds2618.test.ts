import { expect, it } from 'vitest'
import { getFileKind, isBinaryForDiff } from '../../../../apps/desktop/src/session/renderer/lib/editor/fileKind'

it('keeps dotless file names as text', () => { expect(getFileKind('pdf')).toBe('text'); expect(getFileKind('png')).toBe('text'); expect(getFileKind('a.pdf')).toBe('pdf') })
