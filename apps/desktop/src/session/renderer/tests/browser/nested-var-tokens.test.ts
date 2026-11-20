/**
 * Every typography role variable a stylesheet uses must resolve.
 *
 * A vanilla-extract contract value (`tokenVars.fontSans`) is already `var(--em-font-sans)`. Wrapping it again in a
 * template string emits `var(var(--em-font-sans))`; Chromium drops that declaration at parse time, so the role is
 * simply undeclared and every property using it falls back to inheritance. Typecheck, class snapshots and a text scan
 * of the CSSOM can't see a declaration that was never kept; reading the resolved value in a real browser can.
 */
import { expect, it } from 'vitest'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@gugu/session-ui/styles/typography.css'
import '@session-ui/theme/tokens.css'
import '@gugu/session-ui/react/primitives'

function ruleTexts(rules: CSSRuleList, out: string[]): string[] {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) out.push(rule.style.cssText)
    if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) ruleTexts((rule as CSSGroupingRule).cssRules, out)
  }
  return out
}

it('declares every typography role variable that a stylesheet uses', () => {
  const text = Array.from(document.styleSheets).flatMap((sheet) => ruleTexts(sheet.cssRules, [])).join('\n')
  const used = [...new Set(text.match(/var\(--em-type-[\w-]+/g)?.map((ref) => ref.slice(4)) ?? [])]
  // typography.css alone uses 40; fewer means the scan lost its input, and an empty pass would prove nothing.
  expect(used.length).toBeGreaterThanOrEqual(40)
  const root = getComputedStyle(document.documentElement)
  expect(used.filter((name) => root.getPropertyValue(name).trim() === '')).toEqual([])
})

it('resolves a typography role through its primitive token', () => {
  const probe = document.createElement('code')
  probe.className = 'text-role-code'
  document.body.appendChild(probe)
  const reference = document.createElement('code')
  reference.style.fontFamily = 'var(--em-font-mono)'
  document.body.appendChild(reference)
  try {
    expect(getComputedStyle(probe).fontFamily).toBe(getComputedStyle(reference).fontFamily)
  } finally {
    probe.remove()
    reference.remove()
  }
})
