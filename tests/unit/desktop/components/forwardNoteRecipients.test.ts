import { describe, expect, it } from 'vitest'
import { addressedUserIds } from '../../../../apps/desktop/src/lib/mention'

const members = [
  { id: '__all__', name: '所有人', type: 'all' as const },
  { id: 'bot', name: 'Bot', type: 'agent' as const },
  { id: 'leo', name: 'Leo', type: 'human' as const },
]

describe('addressedUserIds, a forward note', () => {
  it('addresses who the note @-s in the one chat, picked or typed, as a typed message does', () => {
    expect(addressedUserIds('@[Bot](aid:bot) look', [{ userId: 'bot', displayName: 'Bot' }], members)).toEqual(['bot'])
    expect(addressedUserIds('@Leo look', [], members)).toEqual(['leo'])
  })

  it('drops a pick whose mention was deleted from the text', () => {
    expect(addressedUserIds('look', [{ userId: 'bot', displayName: 'Bot' }], members)).toEqual([])
  })
})
