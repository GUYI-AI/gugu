import { expect, it } from 'vitest'
import { getFileKind, isBinaryForDiff } from '../../../../apps/desktop/src/session/renderer/lib/editor/fileKind'

it('keeps dotless file names as text', () => { expect(getFileKind('pdf')).toBe('text'); expect(getFileKind('png')).toBe('text'); expect(getFileKind('a.pdf')).toBe('pdf') })

it('keeps PDF diffs out of text models', () => { expect(isBinaryForDiff('a.pdf')).toBe(true); expect(isBinaryForDiff('a.ts')).toBe(false) })

it('uses the image preview for AVIF files', () => { expect(getFileKind('photo.AVIF')).toBe('image'); expect(isBinaryForDiff('photo.avif')).toBe(true) })
