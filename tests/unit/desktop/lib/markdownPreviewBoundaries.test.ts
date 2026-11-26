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

it('preserves private-use text even when escapes need placeholders', () => {
  expect(markdownPlainText('\uE0000\uE000 **bold**')).toBe('\uE0000\uE000 bold')
  expect(markdownPlainText('\uE0000\uE000 \\*x\\*')).toBe('\uE0000\uE000 *x*')
})

it('excludes fenced code with CR-only line endings', () => {
  expect(markdownPlainText('before\r'+String.fromCharCode(96).repeat(3)+'\rhidden\r'+String.fromCharCode(96).repeat(3)+'\rafter')).toBe('before after')
})

it('shows autolink text without Markdown angle brackets', () => {
  expect(markdownPlainText('<https://example.test/a> <a@example.test>')).toBe('https://example.test/a a@example.test')
  expect(markdownPlainText('\\<literal\\>')).toBe('<literal>')
})

it('keeps following words when a link title contains parentheses', () => {
  expect(markdownPlainText('[label](https://example.test "title (") tail')).toBe('label tail')
  expect(markdownPlainText('[label](https://example.test "title )") tail')).toBe('label tail')
  expect(markdownPlainText('[label](https://example.test/a(b)) tail')).toBe('label tail')
})
