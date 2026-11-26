import { expect, it } from 'vitest'
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText'

it('replaces numeric references beyond Unicode without throwing', () => {
  expect(markdownPlainText('before &#1114112; &#xFFFFFF; after')).toBe('before � � after')
})

it('replaces NUL numeric references with the replacement character', () => {
  expect(markdownPlainText('a&#0;b &#x0;')).toBe('a�b �')
})

it('replaces numeric surrogate references and keeps supplementary characters', () => {
  expect(markdownPlainText('&#55296; &#xDFFF; &#128512;')).toBe('� � 😀')
})
