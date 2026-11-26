import { expect, it } from 'vitest'
import { markdownPlainText } from '../../../../apps/desktop/src/lib/markdownPlainText'

it('replaces numeric references beyond Unicode without throwing', () => {
  expect(markdownPlainText('before &#1114112; &#xFFFFFF; after')).toBe('before � � after')
})
