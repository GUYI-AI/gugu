import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { EngineIcon } from '@/components/AgentHarnessIdentity'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import '@/styles/tokens.css'

let harness:ReturnType<typeof createReactHarness>|undefined
afterEach(()=>{harness?.cleanup();document.documentElement.removeAttribute('data-phone-shell')})
it.each(['light','dark'] as const)('%s phone: Pi uses its original mark with a transparent surrounding at 14px',async theme=>{
 await page.viewport(390,844);document.documentElement.dataset.theme=theme;document.documentElement.setAttribute('data-phone-shell','')
 harness=createReactHarness();await harness.render(<EngineIcon engine="pi" size={14}/>)
 const icon=harness.container.querySelector<HTMLElement>('[data-agent-harness="pi"]')!,mark=icon.querySelector<HTMLElement>('.agent-harness-pi-mark')!,original=icon.querySelector('img')!
 expect(CSS.supports('mask-mode','luminance')).toBe(true)
 const style=getComputedStyle(mark),box=mark.getBoundingClientRect()
 expect(style.display).toBe('block');expect(style.maskMode).toBe('luminance');expect(style.maskImage).toContain('data:image/png;base64,')
 expect(style.maskSize).toBe('125%');expect(style.maskRepeat).toBe('no-repeat');expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
 expect(getComputedStyle(original).display).toBe('none');expect(getComputedStyle(icon).backgroundColor).toBe('rgba(0, 0, 0, 0)')
 expect(box.width).toBeCloseTo(14);expect(box.height).toBeCloseTo(14);expect(icon.getAttribute('aria-label')).toBe('Pi CLI')
})
it('keeps the desktop Pi asset unchanged',async()=>{
 harness=createReactHarness();await harness.render(<EngineIcon engine="pi" size={14}/>)
 const icon=harness.container.querySelector<HTMLElement>('[data-agent-harness="pi"]')!
 expect(getComputedStyle(icon.querySelector('.agent-harness-pi-mark')!).display).toBe('none')
 expect(getComputedStyle(icon.querySelector('img')!).display).toBe('block')
})
