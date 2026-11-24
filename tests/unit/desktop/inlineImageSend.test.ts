import { describe, expect, it } from 'vitest'
import { planInlineImageSend } from '@/components/chat/inlineImageSend'

const marker = (id: string) => `![image](gugu-attachment:${id})`
const file = (name: string) => new File(['x'], name, { type: 'image/png' })

describe('planInlineImageSend', () => {
  const a = { id: 'a', file: file('a.png') }, b = { id: 'b', file: file('b.png') }, c = { id: 'c', file: file('c.png') }

  it('is not used when the words hold no picture', () => {
    expect(planInlineImageSend('hello', [a], [])).toBeNull()
  })

  it('sends the words before the first picture first, then each run of pictures with the words after it', () => {
    const plan = planInlineImageSend(`before ${marker('a')} middle ${marker('b')} ${marker('c')} after`, [c, b, a], [])!
    expect(plan.lead).toBe('before')
    expect(plan.files.map((f) => f.name)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(plan.runs).toEqual([{ size: 1, caption: 'middle' }, { size: 2, caption: 'after' }])
    expect(plan.afterLead).toBe(`${marker('a')} middle ${marker('b')} ${marker('c')} after`)
  })

  it('puts files that are not in the words on the last run, and drops pictures no longer held', () => {
    const doc = new File(['d'], 'doc.pdf', { type: 'application/pdf' })
    const plan = planInlineImageSend(`${marker('gone')}${marker('a')} hi`, [a, { id: 'd', file: doc }], [])!
    expect(plan.lead).toBe('')
    expect(plan.files.map((f) => f.name)).toEqual(['a.png', 'doc.pdf'])
    expect(plan.runs).toEqual([{ size: 2, caption: 'hi' }])
  })
})
